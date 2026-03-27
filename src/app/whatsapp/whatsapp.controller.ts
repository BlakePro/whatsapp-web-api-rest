import { Body, Controller, Delete, Get, Param, Post, Res, Sse } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ApiConsumes, ApiProduces, ApiTags } from '@nestjs/swagger';
import { Chat, Contact, WAPresence } from 'baileys';
import { FastifyReply } from 'fastify';
import { Observable, Subject } from 'rxjs';
import { WebhookService } from '../webhook/webhook.service';
import { IMessage, IReadMessages } from './whatsapp.interface';
import { WhatsappService } from './whatsapp.service';

@ApiTags('WhatsApp')
@Controller()
export class WhatsappController {
  private eventEmitter = new Subject<MessageEvent>();

  constructor(
    private whatsapp: WhatsappService,
    private webhooks: WebhookService,
  ) {}

  @Get()
  controllerGetStart(@Res() reply: FastifyReply) {
    this.whatsapp.start();
    const html = this.whatsapp.html();
    reply.type('text/html').send(html);
  }

  @Post('message')
  @ApiProduces('application/json')
  @ApiConsumes('application/json')
  async controllerPostMessage(@Body() payload: IMessage): Promise<any> {
    return await this.whatsapp.sendMessage(payload);
  }

  @Post('simulate')
  @ApiProduces('application/json')
  @ApiConsumes('application/json')
  async controllerPostSimulate(@Body() payload: { chatId: string; action: WAPresence }): Promise<any> {
    const { chatId, action } = payload;
    return await this.whatsapp.sendSimulate(chatId, action);
  }

  @Post('messages/read')
  @ApiProduces('application/json')
  @ApiConsumes('application/json')
  async controllerPostReadMessages(@Body() payload: IReadMessages): Promise<any> {
    return await this.whatsapp.readMessages(payload);
  }

  @Get('profile/status/:chatId')
  @ApiProduces('application/json')
  async controllerGetProfileStatus(@Param('chatId') chatId: string): Promise<object> {
    return await this.whatsapp.getProfileStatus(chatId);
  }

  @Get('profile/picture/:chatId')
  @ApiProduces('application/json')
  async controllerGetProfilePicture(@Param('chatId') chatId: string): Promise<object> {
    return await this.whatsapp.getProfilePicture(chatId);
  }

  @Get('chats')
  @ApiProduces('application/json')
  controllerGetChats(): Chat[] {
    return this.whatsapp.getChats();
  }

  @Get('contacts')
  @ApiProduces('application/json')
  controllerGetContacts(): Contact[] {
    return this.whatsapp.getContacts();
  }

  @Get('number/:numberId')
  @ApiProduces('application/json')
  async controllerGetNumberId(@Param('numberId') numberId: string): Promise<object> {
    return await this.whatsapp.getNumberId(numberId);
  }

  @Get('logout')
  @ApiProduces('application/json')
  async controllerGetLogout(): Promise<any> {
    return await this.whatsapp.logout();
  }

  @Get('webhooks')
  @ApiProduces('application/json')
  controllerGetWebhooks(): string[] {
    return this.webhooks.get();
  }

  @Post('webhooks')
  @ApiProduces('application/json')
  @ApiConsumes('application/json')
  controllerPostWebhooks(@Body() body: { url: string }): { url: string } {
    const url = body?.url;
    this.webhooks.insert(url);
    return { url };
  }

  @Delete('webhooks/:index')
  controllerDeleteWebhooks(@Param('index') index: number): void {
    let noIndex = index;
    if (index > 0) noIndex = noIndex - 1;
    this.webhooks.delete(noIndex);
  }

  @Sse('sse')
  sse(): Observable<MessageEvent> {
    return this.eventEmitter.asObservable();
  }

  @OnEvent('start.event')
  handleCustomEvent(payload: any) {
    const event = { data: JSON.stringify(payload) } as MessageEvent;
    this.eventEmitter.next(event);
  }
}
