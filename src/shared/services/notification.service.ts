// src/shared/services/notification.service.ts
import { StorageService } from "./storage.service";
import { STORAGE_QUEUES } from "../constants";

export class NotificationService {
  private storageService: StorageService;
  
  constructor() {
    this.storageService = new StorageService();
  }
  
  async sendWelcomeEmail(email: string, name: string): Promise<void> {
    const queueClient = this.storageService.getQueueClient(STORAGE_QUEUES.NOTIFICATION);
    await queueClient.sendMessage(Buffer.from(JSON.stringify({
      type: 'welcome',
      recipient: email,
      data: {
        name
      }
    })).toString('base64'));
  }
  
  async requestOtp(email: string, userId: string, type: string): Promise<void> {
    const queueClient = this.storageService.getQueueClient(STORAGE_QUEUES.OTP);
    await queueClient.sendMessage(Buffer.from(JSON.stringify({
      email,
      userId,
      type
    })).toString('base64'));
  }
  
  async sendOtpEmail(email: string, otp: string, expiresAt: number, template: string): Promise<void> {
    const queueClient = this.storageService.getQueueClient(STORAGE_QUEUES.NOTIFICATION);
    await queueClient.sendMessage(Buffer.from(JSON.stringify({
      type: 'email',
      template,
      recipient: email,
      data: {
        otp,
        expiresAt: new Date(expiresAt).toLocaleTimeString()
      }
    })).toString('base64'));
  }
}