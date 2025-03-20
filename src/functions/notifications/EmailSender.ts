// src/functions/notifications/EmailSender.ts
import { app, InvocationContext } from "@azure/functions";
import * as nodemailer from 'nodemailer';
import { createLogger } from "../../shared/utils/logger";

export async function EmailSender(queueItem: unknown, context: InvocationContext): Promise<void> {
  const logger = createLogger(context);
  const message = queueItem as any;
  
  try {
    // Crear cuenta de prueba Ethereal (esto crea una nueva cuenta para cada email)
    const testAccount = await nodemailer.createTestAccount();
    
    // Crear transporter con la cuenta de prueba
    const transporter = nodemailer.createTransport({
        host: 'smtp.ethereal.email',
        port: 587,
        secure: false,
        auth: {
          user: testAccount.user,
          pass: testAccount.pass,
        },
        // Añadir esta configuración para solucionar el problema SSL
        tls: {
          rejectUnauthorized: false // Ignora problemas de certificados (solo para desarrollo)
        }
      });
    
    // Construir email según el tipo de mensaje
    let mailOptions = {
      from: '"AgentAI Platform" <noreply@agentai.com>',
      to: message.recipient,
      subject: '',
      text: '',
      html: ''
    };
    
    if (message.type === 'welcome') {
      mailOptions.subject = '¡Bienvenido a AgentAI Platform!';
      mailOptions.text = `Hola ${message.data.name}, gracias por registrarte en AgentAI Platform.`;
      mailOptions.html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #2c3e50;">¡Bienvenido a AgentAI Platform!</h1>
          <p>Hola ${message.data.name},</p>
          <p>Gracias por registrarte en nuestra plataforma. Estamos emocionados de tenerte con nosotros.</p>
        </div>
      `;
    } else if (message.type === 'email' && message.template?.includes('otp')) {
      mailOptions.subject = 'Tu código de verificación - AgentAI Platform';
      mailOptions.text = `Tu código de verificación es: ${message.data.otp}. Expira a las ${message.data.expiresAt}.`;
      mailOptions.html = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h1 style="color: #2c3e50;">Código de Verificación</h1>
          <p>Tu código de verificación es:</p>
          <div style="background-color: #f8f9fa; padding: 15px; font-size: 24px; text-align: center; letter-spacing: 5px; font-weight: bold;">
            ${message.data.otp}
          </div>
          <p>Este código expirará a las ${message.data.expiresAt}.</p>
        </div>
      `;
    } else {
      mailOptions.subject = 'Notificación - AgentAI Platform';
      mailOptions.text = `Has recibido una notificación.`;
      mailOptions.html = `<p>Has recibido una notificación.</p>`;
    }
    
    // Enviar email
    const info = await transporter.sendMail(mailOptions);
    
    // Generar enlace para previsualizarlo
    logger.info(`📧 Email enviado: ${info.messageId}`);
    logger.info(`📬 Ver email: ${nodemailer.getTestMessageUrl(info)}`);
    
    // Para facilitar las pruebas, mostrar el OTP en los logs
    if (message.type === 'email' && message.template?.includes('otp')) {
      logger.info(`🔑 CÓDIGO OTP PARA PRUEBAS: ${message.data.otp}`);
    }
    
  } catch (error) {
    logger.error('Error al enviar email:', error);
  }
}

app.storageQueue('EmailSender', {
  queueName: 'notification-queue',
  connection: 'AzureWebJobsStorage',
  handler: EmailSender
});