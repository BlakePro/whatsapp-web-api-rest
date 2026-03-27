import { WAPresence } from 'baileys';

interface IContact {
  firstname: string;
  lastname: string;
  phone: string;
  email: string;
}

export interface IReadMessageKey {
  remoteJid: string;
  id: string;
  fromMe?: boolean;
  participant?: string;
}

export interface IReadMessages {
  keys: IReadMessageKey[];
  presence?: WAPresence;
  jid?: string;
}

export interface IMessage {
  chatId: string;
  text: string;
  media?: any;
  location?: any;
  poll?: any;
  contact?: IContact;
  options: any;
}
