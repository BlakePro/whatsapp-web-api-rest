import * as fs from 'node:fs';
import * as path from 'node:path';
import NodeCache from '@cacheable/node-cache';
import { Boom } from '@hapi/boom';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { delay, is, to } from '@src/tools';
import makeWASocket, { Browsers, CacheStore, Chat, ConnectionState, Contact, DisconnectReason, downloadMediaMessage, fetchLatestBaileysVersion, isJidBroadcast, isJidNewsletter, isJidStatusBroadcast, makeCacheableSignalKeyStore, useMultiFileAuthState, WACallEvent, WAMessageKey, WAPresence } from 'baileys';
import P from 'pino';
import { WebhookService } from '../webhook/webhook.service';
import { IMessage, IReadMessages } from './whatsapp.interface';
const qrcode = require('qrcode-terminal');

declare global {
  interface Window {
    WWebJS?: any;
  }
}

// File path for storing chats and contacts in JSON format

/**
 * Starting service for interacting with the WhatsApp Web API
 * Read @whiskeysockets
 * https://baileys.whiskeysockets.io/functions/makeWASocket.html
 */

@Injectable()
export class WhatsappService implements OnModuleInit {
  private client: any = null;
  private isConnected = false;
  private readonly filePath: string = path.join(__dirname, '..', 'whatsapp_data.json');
  private readonly credentialsFolderName = 'auth_info';
  private readonly logger = new Logger('Whatsapp');

  constructor(
    private eventEmitter: EventEmitter2,
    private webhook: WebhookService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.hasSavedSession()) return;

    this.logger.debug('Saved WhatsApp session found, starting automatically...');
    try {
      await this.start();
    } catch (e) {
      this.logger.error('Failed to auto start saved WhatsApp session', e);
    }
  }

  /**
   * Create connection to WA
   */
  private reconnectCount = 0;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private maxConnectionAttemps = 4;
  private pino = P({ level: 'fatal' });

  async start(): Promise<void> {
    this.logger.debug('Start');

    // Check if the client is already connected
    if (this.isConnected && this.client) {
      const text = 'WhatsApp is already connected!';
      this.logger.debug(text);
      await delay(1500);
      this.eventEmitter.emit('start.event', { qr: '', text });
      return;
    }

    const { state, saveCreds } = await useMultiFileAuthState(this.credentialsFolderName);
    const { version } = await fetchLatestBaileysVersion();
    const msgRetryCounterCache = new NodeCache() as CacheStore;

    this.client = makeWASocket({
      version,
      logger: this.pino,
      auth: {
        creds: state.creds,
        /** caching makes the store faster to send/recv messages */
        keys: makeCacheableSignalKeyStore(state.keys, this.pino),
      },
      msgRetryCounterCache,
      generateHighQualityLinkPreview: true,
      // ignore all broadcast messages -- to receive the same
      // comment the line below out
      shouldIgnoreJid: (jid) => isJidBroadcast(jid),
      // implement to handle retries & poll updates
      // getMessage
      browser: Browsers.macOS('Desktop'),
      syncFullHistory: false,
      markOnlineOnConnect: false,
      printQRInTerminal: false,
      retryRequestDelayMs: 350,
      maxMsgRetryCount: 4,
      connectTimeoutMs: 20_000,
      keepAliveIntervalMs: 30_000,
    });

    this.client.ev.on('creds.update', saveCreds);
    this.client.ev.on('connection.update', this.onConnectionUpdate);
    this.client.ev.on('messages.upsert', this.onMessageUpsert);
    this.client.ev.on('call', this.onCall);
    this.client.ev.on('messaging-history.set', this.onMessagingHistory);
  }

  /**
   * Connection state has been updated -- WS closed, opened, connecting etc.
   */
  private onConnectionUpdate = async (connectionState: ConnectionState) => {
    const { connection, lastDisconnect, qr } = connectionState;
    let text = '';

    if (is.string(qr) && qr !== '') {
      qrcode.generate(qr, { small: true });
      this.eventEmitter.emit('start.event', { qr, text: '' });
    }

    // Handle connection close and reconnection logic
    if (connection === 'close') {
      const error = lastDisconnect?.error as Boom;
      const statusCode = error?.output?.statusCode;
      const message = error?.output?.payload?.message || error?.message;
      text = message;

      const shouldReconnect = statusCode !== DisconnectReason.loggedOut && message !== 'QR refs attempts ended' && this.reconnectCount < this.maxConnectionAttemps;

      if (shouldReconnect) {
        ++this.reconnectCount;
        const delay = Math.min(1000 * 2 ** (this.reconnectCount - 1), 30000);

        text = `Reconnecting in ${delay}ms (attempt ${this.reconnectCount})`;

        this.reconnectTimeout = setTimeout(async () => {
          await this.start();
        }, delay);
        return;
      }

      // Reset on permanent failure
      this.reconnectCount = 0;
      this.isConnected = false;
    } else if (connection === 'open') {
      text = 'Connected to WhatsApp!';
      this.reconnectCount = 0;
      if (this.reconnectTimeout) {
        clearTimeout(this.reconnectTimeout);
        this.reconnectTimeout = null;
      }
    }

    if (text !== '') {
      this.eventEmitter.emit('start.event', { qr: '', text });
      this.logger.debug(text);
    }
  };

  // Listen for incoming historical chats and contacts
  private onMessagingHistory = (data: any) => {
    //this.logger.debug('Historical chats and contacts synced');

    const existingData = this.readDataFromFile();

    // Merge new chats and contacts with existing data
    const newChats = data.chats || [];
    const newContacts = data.contacts || [];

    // Append new chats and contacts to existing ones
    const updatedChats = [...existingData.chats, ...newChats];
    const updatedContacts = [...existingData.contacts, ...newContacts];

    // Save updated chats and contacts to the file
    this.saveDataToFile(updatedChats, updatedContacts);
    //this.logger.debug('Chats and contacts saved to whatsapp_data.json');
  };

  /**
   * add/update the given messages. If they were received while the connection was online,
   * the update will have type: "notify"
   */
  private onMessageUpsert = async (waMessage: any) => {
    const messages = waMessage?.messages;
    if (is.array(messages)) {
      const webhooks: any = this.webhook.get();
      if (is.array(webhooks)) {
        for (const item of messages) {
          if (item?.message) {
            //this.logger.log(item)
            const from = to.string(item?.key?.remoteJid);
            if (isJidStatusBroadcast(from) || isJidNewsletter(from) || isJidBroadcast(from)) return;

            // Text
            let type = 'text';
            let message = to.string(item?.message?.conversation);
            if (message === '') message = to.string(item?.message?.extendedTextMessage?.text);

            // Media
            const mimeType = this.getMediaMimeType(item);
            const media = { mimeType, caption: '', base64: '' };
            if (mimeType !== '') {
              type = this.getMediaType(item);
              const mediaBuffer = await downloadMediaMessage(item, 'buffer', {});
              media.caption = this.getMediaCaption(item);
              media.base64 = mediaBuffer.toString('base64');
            }

            // Webhook
            const isMe = to.boolean(item?.key?.fromMe);
            const pushName = to.string(item?.pushName);
            const messageId = to.string(item?.key?.id);
            const participant = to.string(item?.key?.participant);
            await this.webhook.send(webhooks, {
              from,
              pushName,
              isMe,
              type,
              message,
              messageId,
              key: {
                remoteJid: from,
                id: messageId,
                fromMe: isMe,
                participant: participant === '' ? undefined : participant,
              },
              media,
            });
          }
        }
      }
    }
  };

  /**
   * Receive an update on a call, including when the call was received, rejected, accepted
   **/
  private onCall = async (call: WACallEvent) => {
    try {
      await this.client.rejectCall(call?.id, call?.from);
    } catch (_e) {}
    const list: any = this.webhook.get();
    if (is.array(list)) this.webhook.send(list, { call });
  };

  /**
   * Send a message to a specific chatId
   */
  async sendMessage(payload: IMessage): Promise<any | object> {
    try {
      const chatId = to.string(payload?.chatId);
      const { text, options, media, location, poll, contact } = payload;
      let content: any = { text };

      if (is.object(media)) {
        const typeFile = to.string(media?.type);
        const base64 = to.string(media?.data);
        if (typeFile !== '' && base64 !== '') {
          const buffer = Buffer.from(to.string(media?.data), 'base64');
          content = {
            [typeFile]: buffer,
            caption: to.undefined(media?.caption),
            mimetype: to.undefined(media?.mimetype),
            fileName: to.undefined(media?.filename),
            ptt: to.undefined(media?.ptt),
            gifPlayback: to.undefined(media?.gifPlayback),
          };
        }
      } else if (is.object(location)) {
        content = {
          location: {
            ...location,
            name: location?.name,
            url: location?.url,
            address: location?.address,
            degreesLatitude: location?.latitude,
            degreesLongitude: location?.longitude,
          },
        };
      } else if (is.object(poll)) {
        content = {
          poll: {
            name: poll?.name,
            values: poll.options,
            selectableCount: is.undefined(poll?.allowMultipleAnswers) ? 0 : poll?.allowMultipleAnswers,
          },
        };
      } else if (is.object(contact)) {
        const firstname = to.string(contact?.firstname);
        const lastname = to.string(contact?.lastname);
        const email = to.string(contact?.email);
        const phone = to.string(contact?.phone).replace(/ /g, '').replace(/\+/g, '');

        const displayName = `${firstname} ${lastname}`;

        const vcard =
          'BEGIN:VCARD\n' +
          'VERSION:3.0\n' +
          //`N:;${lastname};${firstname};;;\n` +
          `FN:${displayName}\n` +
          `EMAIL;TYPE=Work:${email}\n` +
          `TEL;type=CELL;type=VOICE;waid=${phone}:${phone}\n` +
          'END:VCARD';

        content = {
          contacts: {
            displayName,
            contacts: [{ vcard }],
          },
        };
      }

      if (chatId !== '' && is.object(content)) return this.client.sendMessage(chatId, content, options);
    } catch (e) {
      this.logger.debug(e);
    }
    return {};
  }

  /**
   * Simulate  'unavailable' | 'available' | 'composing' | 'recording' | 'paused';
   */
  async sendSimulate(chatId: string, action: WAPresence): Promise<{ chatId: string }> {
    try {
      await this.client.sendPresenceUpdate(action, chatId);
    } catch (e) {
      this.logger.debug(e);
    }
    return { chatId };
  }

  /**
   * Mark one or many messages as read.
   * Optionally updates presence for the provided/derived jid.
   */
  async readMessages(payload: IReadMessages): Promise<{ read: number; keys: WAMessageKey[] }> {
    const keys = is.array(payload?.keys) ? payload.keys : [];
    const parsedKeys = keys
      .map((key) => ({
        remoteJid: to.string(key?.remoteJid),
        id: to.string(key?.id),
        fromMe: to.boolean(key?.fromMe),
        participant: to.undefined(key?.participant),
      }))
      .filter((key) => key.remoteJid !== '' && key.id !== '') as WAMessageKey[];

    if (parsedKeys.length === 0) return { read: 0, keys: [] };

    try {
      await this.client.readMessages(parsedKeys);

      const presence = payload?.presence as WAPresence;
      const jid = to.string(payload?.jid || parsedKeys[0]?.remoteJid);
      if (!is.undefined(presence) && jid !== '') {
        await this.client.sendPresenceUpdate(presence, jid);
      }
    } catch (e) {
      this.logger.debug(e);
    }

    return { read: parsedKeys.length, keys: parsedKeys };
  }

  /**
   * Return the status of a person/group
   */
  async getProfileStatus(chatId: string): Promise<object> {
    let status = {};
    try {
      status = await this.client.fetchStatus(chatId);
    } catch (_e) {}
    return { status };
  }

  /**
   * Return the profile url picture of a person/group
   */
  async getProfilePicture(chatId: string): Promise<object> {
    let url = '';
    try {
      url = await this.client.profilePictureUrl(chatId, 'image');
    } catch (_e) {}
    return { url };
  }

  /**
   * Get all current chat instances
   */
  getChats(): Chat[] {
    try {
      const { chats } = this.readDataFromFile();
      return chats;
    } catch (_e) {
      return [];
    }
  }

  /**
   * Get all current contact instances
   */
  getContacts(): Contact[] {
    try {
      const { contacts } = this.readDataFromFile();
      return contacts;
    } catch (_e) {
      return [];
    }
  }

  /**
   * Get the registered WhatsApp ID for a number.
   * Will return null if the number is not registered on WhatsApp.
   */
  async getNumberId(number: string): Promise<object> {
    let result = {};
    try {
      [result] = await this.client.onWhatsApp(number);
    } catch (_e) {}
    return result;
  }

  /*
   * Close actual session
   */
  async logout(): Promise<void> {
    try {
      await this.client.logout();
    } catch (e) {
      this.logger.debug(e);
    }
  }

  /**
   * Start html page for event emitter
   */
  html(): string {
    const color = 'rgba(50, 50, 50, 0.8)';
    return `<!DOCTYPE html>
      <html lang="en">
      <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>API</title>
          <script src="/public/easy.qrcode.min.js"></script>
          <script src="/public/script.js"></script>
          <style>
            body, #qr {
              display: flex;
              flex-direction: column;
              justify-content: center;
              align-items: center;
              color: ${color};
              font-size: 1.4em;
            }
            body{
              height: 90vh;
            }
            #text{
              padding: 6px;
              font-weight: bold;
              text-align: center;
            }
          </style>
      </head>
      <body>
        <div id="text"></div>
        <div id="qr">
          <div style="width: 80px; height: 80px;">
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><radialGradient id="a12" cx=".66" fx=".66" cy=".3125" fy=".3125" gradientTransform="scale(1.5)"><stop offset="0" stop-color="${color}"></stop><stop offset=".3" stop-color="${color}" stop-opacity=".9"></stop><stop offset=".6" stop-color="${color}" stop-opacity=".6"></stop><stop offset=".8" stop-color="${color}" stop-opacity=".3"></stop><stop offset="1" stop-color="${color}" stop-opacity="0"></stop></radialGradient><circle transform-origin="center" fill="none" stroke="url(#a12)" stroke-width="15" stroke-linecap="round" stroke-dasharray="200 1000" stroke-dashoffset="0" cx="100" cy="100" r="70"><animateTransform type="rotate" attributeName="transform" calcMode="spline" dur="1" values="360;0" keyTimes="0;1" keySplines="0 0 1 1" repeatCount="indefinite"></animateTransform></circle><circle transform-origin="center" fill="none" opacity=".2" stroke="${color}" stroke-width="15" stroke-linecap="round" cx="100" cy="100" r="70"></circle></svg>
          </div>
        </div>
      </body>
    </html>`;
  }

  // Return the type of converstion mimetype
  private getMediaMimeType(conversation: any): string {
    if (!conversation?.message) return '';

    const { imageMessage, videoMessage, documentMessage, audioMessage, documentWithCaptionMessage } = conversation?.message || {};

    return to.string(imageMessage?.mimetype ?? audioMessage?.mimetype ?? videoMessage?.mimetype ?? documentMessage?.mimetype ?? documentWithCaptionMessage?.message?.documentMessage?.mimetype);
  }

  private getMediaCaption(conversation: any): string {
    if (!conversation?.message) return '';

    const { imageMessage, videoMessage, documentMessage, audioMessage, documentWithCaptionMessage } = conversation?.message || {};

    return to.string(imageMessage?.caption ?? audioMessage?.caption ?? videoMessage?.caption ?? documentMessage?.caption ?? documentWithCaptionMessage?.message?.documentMessage?.caption);
  }

  private getMediaType(conversation: any): string {
    if (!conversation?.message) return '';

    const { imageMessage, videoMessage, documentMessage, audioMessage, documentWithCaptionMessage } = conversation?.message || {};

    if (imageMessage) return 'image';
    if (videoMessage) return 'video';
    if (audioMessage) return 'audio';
    if (documentMessage) return 'document';
    if (documentWithCaptionMessage?.message?.documentMessage) return 'document';

    // If mimetype is available but message type unknown, derive from MIME prefix
    const mimetype = imageMessage?.mimetype ?? videoMessage?.mimetype ?? audioMessage?.mimetype ?? documentMessage?.mimetype ?? documentWithCaptionMessage?.message?.documentMessage?.mimetype ?? '';

    if (mimetype.startsWith('image/')) return 'image';
    if (mimetype.startsWith('video/')) return 'video';
    if (mimetype.startsWith('audio/')) return 'audio';
    if (mimetype.startsWith('application/')) return 'document';

    return 'unknown';
  }

  private hasSavedSession(): boolean {
    const sessionPath = path.resolve(this.credentialsFolderName);
    if (!fs.existsSync(sessionPath)) return false;

    const stats = fs.statSync(sessionPath);
    if (!stats.isDirectory()) return false;

    const files = fs.readdirSync(sessionPath);
    return files.includes('creds.json');
  }

  // Read existing data from the JSON file
  private readDataFromFile(): { chats: Chat[]; contacts: Contact[] } {
    if (fs.existsSync(this.filePath)) {
      const data = fs.readFileSync(this.filePath, 'utf8');
      return JSON.parse(data);
    }
    return { chats: [], contacts: [] };
  }

  // Save chats and contacts to the JSON file
  private saveDataToFile(chats: Chat[], contacts: Contact[]) {
    fs.writeFileSync(this.filePath, JSON.stringify({ chats, contacts }, null, 2), 'utf8');
  }
}
