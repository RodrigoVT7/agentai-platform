// src/shared/handlers/integrations/whatsAppIntegrationHandler.ts
import { v4 as uuidv4 } from "uuid";
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES, STORAGE_QUEUES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import {
  Integration,
  IntegrationType,
  IntegrationStatus,
  IntegrationWhatsAppConfig,
} from "../../models/integration.model";
import { HttpResponseInit } from "@azure/functions";
import fetch from "node-fetch";
import {
  MessageRequest,
  MessageType,
  MessageStatus,
} from "../../models/conversation.model";
import { MessageReceiverHandler } from "../conversation/messageReceiverHandler";
import { TableClient } from "@azure/data-tables";
import {
  HandleWhatsAppEmbeddedSignupInput,
} from "../../models/meta.model"; // Import only the input model
import { MetaPlatformService } from "../../services/metaPlatform.service"; // NEW: Import MetaPlatformService

// Type for WhatsApp message data (already defined in src/types/whatsapp.ts, but repeated here for clarity/self-containment)
type WhatsAppMessageData = {
  integrationId: string;
  to: string;
  type: "text" | "template" | "image" | "document" | "interactive";
  text?: { body: string; preview_url?: boolean };
  template?: {
    name: string;
    language: { code: string };
    components?: any[];
  };
  image?: { id?: string; link?: string; caption?: string };
  document?: {
    id?: string;
    link?: string;
    caption?: string;
    filename?: string;
  };
  interactive?: any;
  internalMessageId?: string;
};


export class WhatsAppIntegrationHandler {
  private storageService: StorageService;
  private logger: Logger;
  private tableClient: TableClient;
  private metaPlatformService: MetaPlatformService; // NEW: Instance of MetaPlatformService

  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
    this.tableClient = this.storageService.getTableClient(
      STORAGE_TABLES.INTEGRATIONS
    );
    this.metaPlatformService = new MetaPlatformService(this.logger); // NEW: Initialize MetaPlatformService
  }

  // Getter para el storageService para permitir acceso al timer trigger
  get tableService(): StorageService {
    return this.storageService;
  }

  async getStatus(
    integrationId: string,
    userId: string
  ): Promise<HttpResponseInit> {
    try {
      // Verificar si la integración existe y el usuario tiene acceso
      const integration = await this.fetchIntegration(integrationId);

      if (!integration) {
        return {
          status: 404,
          jsonBody: { error: "Integración no encontrada" },
        };
      }

      const hasAccess = await this.verifyAccess(integration.agentId, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: {
            error: "No tienes permiso para acceder a esta integración",
          },
        };
      }

      // Verificar estado actual con la API de WhatsApp
      try {
        const config = JSON.parse(
          integration.config as string
        ) as IntegrationWhatsAppConfig;
        
        // Use MetaPlatformService to get phone number data
        const phoneData = await this.metaPlatformService.getPhoneNumberData(
          config.businessAccountId,
          config.accessToken,
          config.phoneNumberId
        );

        if (!phoneData) {
          // If there's a problem with the API or phone not found, update integration status
          await this.updateIntegrationStatus(
            integrationId,
            integration.agentId,
            IntegrationStatus.ERROR
          );

          return {
            status: 200,
            jsonBody: {
              id: integrationId,
              status: IntegrationStatus.ERROR,
              message: "Error al conectar con la API de WhatsApp o número no encontrado",
              lastCheck: Date.now(),
            },
          };
        }

        // If everything is fine, update status if necessary
        if (integration.status !== IntegrationStatus.ACTIVE) {
          await this.updateIntegrationStatus(
            integrationId,
            integration.agentId,
            IntegrationStatus.ACTIVE
          );
        }

        return {
          status: 200,
          jsonBody: {
            id: integrationId,
            status: IntegrationStatus.ACTIVE,
            phone: phoneData.display_phone_number,
            name: phoneData.verified_name,
            qualityRating: phoneData.quality_rating,
            lastCheck: Date.now(),
          },
        };
      } catch (error) {
        this.logger.error(
          `Error al verificar estado de WhatsApp para ${integrationId}:`,
          error
        );

        // Update status to ERROR
        await this.updateIntegrationStatus(
          integrationId,
          integration.agentId,
          IntegrationStatus.ERROR
        );

        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          status: 500, // Return 500 if it's a general handler error, not necessarily from Meta API
          jsonBody: { error: `Error al verificar estado: ${errorMessage}` },
        };
      }
    } catch (error) {
      this.logger.error(
        `Error al obtener estado de integración ${integrationId}:`,
        error
      );

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        status: 500,
        jsonBody: { error: `Error al obtener estado: ${errorMessage}` },
      };
    }
  }

  async listNumbers(
    agentId: string,
    userId: string
  ): Promise<HttpResponseInit> {
    try {
      // Verificar acceso al agente
      const hasAccess = await this.verifyAccess(agentId, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para acceder a este agente" },
        };
      }

      // Buscar integraciones de tipo WhatsApp para este agente
      const tableClient = this.storageService.getTableClient(
        STORAGE_TABLES.INTEGRATIONS
      );

      const whatsappIntegrations: any[] = [];
      const integrations = await tableClient.listEntities({
        queryOptions: {
          filter: `PartitionKey eq '${agentId}' and type eq '${IntegrationType.MESSAGING}' and provider eq 'whatsapp' and isActive eq true`,
        },
      });

      for await (const integration of integrations) {
        const config =
          typeof integration.config === "string"
            ? JSON.parse(integration.config)
            : integration.config;

        whatsappIntegrations.push({
          id: integration.id,
          name: integration.name,
          status: integration.status,
          phoneNumber: config.phoneNumber,
          displayName: config.displayName,
        });
      }

      return {
        status: 200,
        jsonBody: {
          agentId,
          integrations: whatsappIntegrations,
        },
      };
    } catch (error) {
      this.logger.error(
        `Error al listar números de WhatsApp para agente ${agentId}:`,
        error
      );

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        status: 500,
        jsonBody: { error: `Error al listar números: ${errorMessage}` },
      };
    }
  }

  async setupIntegration(data: any, userId: string): Promise<HttpResponseInit> {
    try {
      const {
        agentId,
        name,
        phoneNumberId,
        businessAccountId,
        accessToken,
        webhookVerifyToken,
        phoneNumber,
        displayName,
      } = data;

      // Verificar acceso al agente
      const hasAccess = await this.verifyAccess(agentId, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para modificar este agente" },
        };
      }

      // Validar conexión con WhatsApp using MetaPlatformService
      try {
        const phoneData = await this.metaPlatformService.getPhoneNumberData(
            businessAccountId,
            accessToken,
            phoneNumberId
        );

        if (!phoneData) {
          return {
            status: 400,
            jsonBody: {
              error: "Credenciales inválidas para WhatsApp o número no encontrado",
            },
          };
        }
        // Ensure that the provided phone number matches the one retrieved from Meta
        if (phoneData.display_phone_number !== phoneNumber) {
            this.logger.warn(`Provided phone number ${phoneNumber} does not match Meta's ${phoneData.display_phone_number}. Using Meta's.`);
            data.phoneNumber = phoneData.display_phone_number; // Correct it
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
        return {
          status: 400,
          jsonBody: {
            error: "Error al verificar credenciales de WhatsApp",
            details: errorMessage,
          },
        };
      }

      // Generar ID para la integración
      const integrationId = uuidv4();
      const now = Date.now();

      // Crear configuración de WhatsApp
      const config: IntegrationWhatsAppConfig = {
        phoneNumberId,
        businessAccountId,
        accessToken,
        webhookVerifyToken,
        phoneNumber: data.phoneNumber, // Use potentially corrected phone number
        displayName: displayName || name,
        // Set platformManaged to false for manual setup
        platformManaged: false,
      };

      // Create new integration
      const integration: Integration = {
        id: integrationId,
        agentId,
        name,
        description: `Integración con WhatsApp para el número ${data.phoneNumber}`,
        type: IntegrationType.MESSAGING,
        provider: "whatsapp",
        config: JSON.stringify(config),
        credentials: accessToken, // In production, encrypt
        status: IntegrationStatus.CONFIGURED,
        createdBy: userId,
        createdAt: now,
        isActive: true,
      };

      // Save to Table Storage
      const tableClient = this.storageService.getTableClient(
        STORAGE_TABLES.INTEGRATIONS
      );
      await tableClient.createEntity({
        partitionKey: agentId,
        rowKey: integrationId,
        ...integration,
      });

      return {
        status: 201,
        jsonBody: {
          id: integrationId,
          name,
          phoneNumber: data.phoneNumber,
          status: IntegrationStatus.CONFIGURED,
          message: "Integración de WhatsApp creada con éxito",
        },
      };
    } catch (error) {
      this.logger.error("Error al configurar integración de WhatsApp:", error);

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        status: 500,
        jsonBody: { error: `Error al configurar integración: ${errorMessage}` },
      };
    }
  }

  public async sendMessage(
    messageData: WhatsAppMessageData, // Use the specific type
    userId: string
  ): Promise<HttpResponseInit> {
    try {
      const { integrationId, to, type, internalMessageId } = messageData;

      const integration = await this.fetchIntegration(integrationId);
      if (!integration) {
        return {
          status: 404,
          jsonBody: { error: "Integración no encontrada" },
        };
      }

      if (integration.status !== IntegrationStatus.ACTIVE) {
        return {
          status: 400,
          jsonBody: {
            error: `La integración WhatsApp (${integration.name}) no está activa.`,
          },
        };
      }

      const config = JSON.parse(
        integration.config as string
      ) as IntegrationWhatsAppConfig;

      const accessToken = config.accessToken; // Assumed to be validated/refreshed token

      // 3. Build Payload for the WhatsApp API
      const payload: any = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to, // Recipient's number
        type: type,
      };

      // Add the specific object based on type
      switch (type) {
        case "text":
          if (!messageData.text || !messageData.text.body) {
            return {
              status: 400,
              jsonBody: {
                error: "Falta el cuerpo del mensaje de texto (text.body).",
              },
            };
          }
          payload.text = messageData.text;
          break;
        case "template":
          if (
            !messageData.template ||
            !messageData.template.name ||
            !messageData.template.language?.code
          ) {
            return {
              status: 400,
              jsonBody: {
                error: "Faltan datos de la plantilla (name, language.code).",
              },
            };
          }
          payload.template = messageData.template;
          break;
        case "image":
          if (
            !messageData.image ||
            (!messageData.image.id && !messageData.image.link)
          ) {
            return {
              status: 400,
              jsonBody: { error: "Se requiere ID o link para la imagen." },
            };
          }
          payload.image = messageData.image;
          break;
        case "document":
          if (
            !messageData.document ||
            (!messageData.document.id && !messageData.document.link)
          ) {
            return {
              status: 400,
              jsonBody: { error: "Se requiere ID o link para el documento." },
            };
          }
          // filename is required if link is used
          if (messageData.document.link && !messageData.document.filename) {
            return {
              status: 400,
              jsonBody: {
                error:
                  "Se requiere 'filename' cuando se usa 'link' para documentos.",
              },
            };
          }
          payload.document = messageData.document;
          break;
        case "interactive":
          if (!messageData.interactive) {
            return {
              status: 400,
              jsonBody: { error: "Faltan datos interactivos." },
            };
          }
          payload.interactive = messageData.interactive; // Assumes correct format
          break;
        default:
          return {
            status: 400,
            jsonBody: {
              error: `Tipo de mensaje no soportado para envío: ${type}`,
            },
          };
      }

      // 4. Send Request to Meta Graph API
      this.logger.info(
        `Enviando mensaje a ${to} via ${
          config.phoneNumberId
        }. Payload: ${JSON.stringify(payload)}`
      );
      const response = await fetch(
        `https://graph.facebook.com/v18.0/${config.phoneNumberId}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${accessToken}`, // Use the validated/refreshed token
          },
          body: JSON.stringify(payload),
        }
      );

      // 5. Handle API Response
      const responseBody = await response.json(); // Read response body regardless of status
      if (!response.ok) {
        this.logger.error(
          `Error al enviar mensaje WA (${response.status}): ${JSON.stringify(
            responseBody
          )}`
        );
        if (internalMessageId) {
          // You might update your internal message status to FAILED here
          // await this.updateInternalMessageStatus(internalMessageId, conversationId, MessageStatus.FAILED, responseBody);
        }
        return {
          status: 400,
          jsonBody: {
            error: "Error al enviar mensaje a WhatsApp",
            apiError: responseBody,
          },
        };
      }

      this.logger.info(
        `Respuesta de envío WA: ${JSON.stringify(responseBody)}`
      );
      const waMessageId = responseBody.messages?.[0]?.id; // Get WhatsApp message ID

      // 6. Log Success and Return Response
      this.logMessageSent(
        integration.agentId,
        integrationId,
        to,
        type,
        waMessageId || "N/A"
      );

      if (internalMessageId && waMessageId) {
        // You might update your internal message metadata with waMessageId here
        // await this.updateInternalMessageMetadata(internalMessageId, conversationId, { whatsapp: { waMessageId } });
      }

      return {
        status: 200,
        jsonBody: {
          success: true,
          to: to,
          type: type,
          waMessageId: waMessageId,
        },
      };
    } catch (error) {
      this.logger.error(
        `Error fatal en sendMessage para integración ${messageData.integrationId}:`,
        error
      );
      return {
        status: 500,
        jsonBody: { error: "Error interno del servidor al enviar mensaje." },
      };
    }
  }

  public async processWebhook(webhookData: any): Promise<void> {
    this.logger.info(`Procesando webhook: ${JSON.stringify(webhookData)}`);

    try {
      if (
        !webhookData.object ||
        !webhookData.entry ||
        webhookData.entry.length === 0
      ) {
        this.logger.warn("Webhook con formato inválido o vacío.");
        return;
      }

      for (const entry of webhookData.entry) {
        if (!entry.changes || entry.changes.length === 0) continue;

        for (const change of entry.changes) {
          if (change.field !== "messages" || !change.value) continue;

          const { metadata, messages, statuses, contacts } = change.value;
          const phoneNumberId = metadata?.phone_number_id;

          if (!phoneNumberId) {
            this.logger.warn(
              "No se encontró phoneNumberId en los metadatos del webhook."
            );
            continue;
          }

          const integration = await this.findIntegrationByPhoneNumberId(
            phoneNumberId
          );
          if (!integration) {
            this.logger.warn(
              `Webhook recibido para un número no configurado o inactivo: ${phoneNumberId}`
            );
            continue;
          }

          if (messages && messages.length > 0) {
            const contact =
              contacts && contacts.length > 0 ? contacts[0] : null;
            for (const message of messages) {
              await this.processIncomingMessage(integration, message, contact);
            }
          }

          if (statuses && statuses.length > 0) {
            for (const statusUpdate of statuses) {
              await this.processStatusUpdate(integration, statusUpdate);
            }
          }
        }
      }
    } catch (error) {
      this.logger.error(
        "Error detallado al procesar webhook de WhatsApp:",
        error
      );
    }
  }

private async processStatusUpdate(
  integration: Integration,
  statusUpdate: any
): Promise<void> {
  const waMessageId = statusUpdate.id;
  const status = statusUpdate.status;
  const timestamp = parseInt(statusUpdate.timestamp) * 1000;

  this.logger.info(`Actualización de estado recibida para mensaje WA ${waMessageId}: ${status}`);

  try {
    const messagesTableClient = this.storageService.getTableClient(STORAGE_TABLES.MESSAGES);
    
    // **INICIO DE LA CORRECCIÓN**
    // No podemos filtrar por JSON anidado directamente en la consulta.
    // La estrategia es buscar todos los mensajes recientes y filtrarlos en memoria.
    // Esto es menos eficiente que un índice, pero funciona sin cambios en la estructura de la tabla.
    
    const messageEntities = messagesTableClient.listEntities();
    let foundMessage: any = null;

    for await (const message of messageEntities) {
      if (message.metadata && typeof message.metadata === 'string') {
        try {
          const metadata = JSON.parse(message.metadata);
          if (metadata.whatsapp?.waMessageId === waMessageId) {
            foundMessage = message;
            break; // Mensaje encontrado, salimos del bucle.
          }
        } catch {
          // Ignorar errores de parseo en metadata de otros mensajes.
        }
      }
    }
    // **FIN DE LA CORRECCIÓN**

    if (foundMessage) {
      const internalMessageId = foundMessage.rowKey as string;
      const conversationId = foundMessage.partitionKey as string;

      let newStatus: MessageStatus;
      switch (status) {
        case "sent": newStatus = MessageStatus.SENT; break;
        case "delivered": newStatus = MessageStatus.DELIVERED; break;
        case "read": newStatus = MessageStatus.READ; break;
        case "failed": newStatus = MessageStatus.FAILED; break;
        default: newStatus = foundMessage.status as MessageStatus;
      }

      const statusOrder = [MessageStatus.SENT, MessageStatus.DELIVERED, MessageStatus.READ];
      const currentStatusIndex = statusOrder.indexOf(foundMessage.status as MessageStatus);
      const newStatusIndex = statusOrder.indexOf(newStatus);

      // Solo actualizamos si el nuevo estado es más avanzado o es un fallo.
      if (newStatus === MessageStatus.FAILED || newStatusIndex > currentStatusIndex) {
        const updatePayload: any = {
          partitionKey: conversationId,
          rowKey: internalMessageId,
          status: newStatus,
          updatedAt: timestamp,
        };
        if (status === "failed" && statusUpdate.errors) {
          updatePayload.errorMessage = JSON.stringify(statusUpdate.errors).substring(0, 1024);
        }
        await messagesTableClient.updateEntity(updatePayload, "Merge");
        this.logger.info(`Estado del mensaje interno ${internalMessageId} actualizado a ${newStatus}`);
      } else {
        this.logger.info(`Estado ${status} ignorado para mensaje ${internalMessageId} (estado actual: ${foundMessage.status})`);
      }
    } else {
      this.logger.warn(`No se encontró el mensaje interno correspondiente al ID de WhatsApp ${waMessageId}`);
    }
  } catch (error) {
    this.logger.error(`Error al procesar actualización de estado para mensaje WA ${waMessageId}:`, error);
  }
}

  async updateIntegration(
    integrationId: string,
    data: any,
    userId: string
  ): Promise<HttpResponseInit> {
    try {
      const integration = await this.fetchIntegration(integrationId);

      if (!integration) {
        return {
          status: 404,
          jsonBody: { error: "Integración no encontrada" },
        };
      }

      const hasAccess = await this.verifyAccess(integration.agentId, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: {
            error: "No tienes permiso para modificar esta integración",
          },
        };
      }

      const config = JSON.parse(
        integration.config as string
      ) as IntegrationWhatsAppConfig;
      const updatedConfig: IntegrationWhatsAppConfig = {
        ...config,
        displayName: data.displayName || config.displayName,
        webhookVerifyToken:
          data.webhookVerifyToken || config.webhookVerifyToken,
        accessToken: data.accessToken || config.accessToken,
        messagingLimit: data.messagingLimit || config.messagingLimit,
      };

      const updateData: any = {
        partitionKey: integration.agentId,
        rowKey: integrationId,
        config: updatedConfig,
        updatedAt: Date.now(),
      };

      if (data.name) {
        updateData.name = data.name;
      }

      if (data.description) {
        updateData.description = data.description;
      }

      if (data.accessToken) {
        updateData.credentials = data.accessToken;
      }

      const tableClient = this.storageService.getTableClient(
        STORAGE_TABLES.INTEGRATIONS
      );
      await tableClient.updateEntity(updateData, "Merge");

      return {
        status: 200,
        jsonBody: {
          id: integrationId,
          name: data.name || integration.name,
          status: integration.status,
          message: "Integración de WhatsApp actualizada con éxito",
        },
      };
    } catch (error) {
      this.logger.error(
        `Error al actualizar integración de WhatsApp ${integrationId}:`,
        error
      );

      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        status: 500,
        jsonBody: { error: `Error al actualizar integración: ${errorMessage}` },
      };
    }
  }

  private async fetchIntegration(
    integrationId: string
  ): Promise<Integration | null> {
    try {
      const tableClient = this.storageService.getTableClient(
        STORAGE_TABLES.INTEGRATIONS
      );

      const integrations = tableClient.listEntities({
        queryOptions: { filter: `RowKey eq '${integrationId}'` },
      });

      for await (const integration of integrations) {
        return integration as unknown as Integration;
      }

      return null;
    } catch (error) {
      this.logger.error(`Error al buscar integración ${integrationId}:`, error);
      return null;
    }
  }

  private async findIntegrationByPhoneNumberId(
    phoneNumberId: string
  ): Promise<Integration | null> {
    try {
      const tableClient = this.storageService.getTableClient(
        STORAGE_TABLES.INTEGRATIONS
      );

      const integrations = tableClient.listEntities({
        queryOptions: {
          filter: `provider eq 'whatsapp' and isActive eq true`,
        },
      });

      for await (const integration of integrations) {
        const config =
          typeof integration.config === "string"
            ? JSON.parse(integration.config)
            : integration.config;

        if (config.phoneNumberId === phoneNumberId) {
          return integration as unknown as Integration;
        }
      }

      return null;
    } catch (error) {
      this.logger.error(
        `Error al buscar integración por phoneNumberId ${phoneNumberId}:`,
        error
        );
      return null;
    }
  }

  private async verifyAccess(
    agentId: string,
    userId: string
  ): Promise<boolean> {
    try {
      const agentsTable = this.storageService.getTableClient(
        STORAGE_TABLES.AGENTS
      );

      try {
        const agent = await agentsTable.getEntity("agent", agentId);

        if (agent.userId === userId) {
          return true;
        }
      } catch (error) {
        return false;
      }

      const rolesTable = this.storageService.getTableClient(
        STORAGE_TABLES.USER_ROLES
      );
      const roles = rolesTable.listEntities({
        queryOptions: {
          filter: `agentId eq '${agentId}' and userId eq '${userId}' and isActive eq true`,
        },
      });

      for await (const role of roles) {
        return true;
      }

      return false;
    } catch (error) {
      this.logger.error(
        `Error al verificar acceso al agente ${agentId}:`,
        error
      );
      return false;
    }
  }

  private async updateIntegrationStatus(
    integrationId: string,
    agentId: string,
    status: IntegrationStatus
  ): Promise<void> {
    try {
      const tableClient = this.storageService.getTableClient(
        STORAGE_TABLES.INTEGRATIONS
      );

      await tableClient.updateEntity(
        {
          partitionKey: agentId,
          rowKey: integrationId,
          status,
          updatedAt: Date.now(),
        },
        "Merge"
      );
    } catch (error) {
      this.logger.error(
        `Error al actualizar estado de integración ${integrationId}:`,
        error
      );
    }
  }

  private async logMessageSent(
    agentId: string,
    integrationId: string,
    to: string,
    type: string,
    messageId: string
  ): Promise<void> {
    try {
      const tableClient = this.storageService.getTableClient(
        STORAGE_TABLES.INTEGRATION_LOGS
      );

      const logId = uuidv4();
      const now = Date.now();

      await tableClient.createEntity({
        partitionKey: agentId,
        rowKey: logId,
        integrationId,
        action: "message_sent",
        recipient: to,
        messageType: type,
        messageId,
        timestamp: now,
      });
    } catch (error) {
      this.logger.error(`Error al registrar mensaje enviado:`, error);
    }
  }

  private async processIncomingMessage(
    integration: Integration,
    message: any,
    contact: any
  ): Promise<void> {
    try {
      const agentId = integration.agentId;
      const from = message.from;
      const waMessageId = message.id;
      const timestamp = parseInt(message.timestamp) * 1000;
      const profileName = contact?.profile?.name || "Usuario de WhatsApp";

      let content = "";
      let messageType: MessageType = MessageType.TEXT;
      let attachments: Record<string, any> | undefined = undefined;

      switch (message.type) {
        case "text":
          content = message.text?.body || "";
          messageType = MessageType.TEXT;
          break;
        case "image":
          content = message.image?.caption || "[Imagen Recibida]";
          messageType = MessageType.IMAGE;
          attachments = {
            image: {
              id: message.image?.id,
              mime_type: message.image?.mime_type,
            },
          };
          this.logger.info(`Imagen recibida: ${message.image?.id}`);
          break;
        case "document":
          content = message.document?.caption || "[Documento Recibido]";
          messageType = MessageType.FILE;
          attachments = {
            document: {
              id: message.document?.id,
              filename: message.document?.filename,
              mime_type: message.document?.mime_type,
            },
          };
          this.logger.info(`Documento recibido: ${message.document?.filename}`);
          break;
        case "audio":
          content = "[Audio Recibido]";
          messageType = MessageType.AUDIO;
          attachments = {
            audio: {
              id: message.audio?.id,
              mime_type: message.audio?.mime_type,
            },
          };
          this.logger.info(`Audio recibido: ${message.audio?.id}`);
          break;
        case "interactive":
          if (message.interactive?.button_reply) {
            content = message.interactive.button_reply.title;
            messageType = MessageType.TEXT;
            this.logger.info(
              `Respuesta de botón recibida: ${content} (ID: ${message.interactive.button_reply.id})`
            );
          } else if (message.interactive?.list_reply) {
            content = message.interactive.list_reply.title;
            messageType = MessageType.TEXT;
            this.logger.info(
              `Respuesta de lista recibida: ${content} (ID: ${message.interactive.list_reply.id})`
            );
          } else {
            this.logger.warn(
              "Mensaje interactivo desconocido:",
              message.interactive
            );
            return;
          }
          break;
        default:
          this.logger.warn(
            `Tipo de mensaje de WhatsApp no manejado: ${message.type}`
          );
          return;
      }

      if (!content && !attachments) {
        this.logger.warn(
          `Mensaje de tipo ${message.type} sin contenido procesable.`
        );
        return;
      }

      const messageRequest: MessageRequest = {
        agentId,
        content: content || `[${messageType}]`,
        messageType: messageType,
        sourceChannel: "whatsapp",
        metadata: {
          whatsapp: {
            from: from,
            fromName: profileName,
            waMessageId: waMessageId,
            timestamp: timestamp,
            integrationId: integration.id,
          },
          attachments: attachments,
        },
      };

      const messageReceiverHandler = new MessageReceiverHandler(this.logger);

      const placeholderUserId = `whatsapp:${from}`;

      await messageReceiverHandler.execute(messageRequest, placeholderUserId);

      this.logger.info(
        `Mensaje entrante de WhatsApp ${waMessageId} procesado y encolado.`
      );
    } catch (error) {
      this.logger.error(
        `Error al procesar mensaje entrante de WhatsApp ${message?.id}:`,
        error
      );
    }
  }

  // Handle Meta Embedded Signup (moved from WhatsAppIntegration.ts)
  public async handleEmbeddedSignupCode(
    requestBody: HandleWhatsAppEmbeddedSignupInput,
    userId: string
  ): Promise<HttpResponseInit> {
    try {
      const {
        agentId,
        esIntegrationCode,
        phoneNumberId,
        whatsAppBusinessAccountId,
        businessId,
      } = requestBody;

      // 1. Exchange the ES Integration Code for a User Access Token
      const tokenResponse = await this.metaPlatformService.exchangeCodeForToken(
        esIntegrationCode
      );
      if (!tokenResponse || !tokenResponse.access_token) {
        this.logger.error("Failed to exchange code for access token.");
        return this.buildErrorResponse(
          400,
          "Code exchange failed",
          "AUTH_CODE_EXCHANGE_FAIL"
        );
      }
      const accessToken = tokenResponse.access_token;
      const userAccessTokenExpiresAt = tokenResponse.expires_in
        ? Date.now() + tokenResponse.expires_in * 1000
        : undefined;

      // 2. Get Phone Number Data using the new access token
      const phoneData = await this.metaPlatformService.getPhoneNumberData(
        whatsAppBusinessAccountId,
        accessToken,
        phoneNumberId
      );
      if (!phoneData) {
        this.logger.error(
          `Phone number ${phoneNumberId} not found in WABA ${whatsAppBusinessAccountId}.`
        );
        return this.buildErrorResponse(
          400,
          "Phone number not found in WhatsApp Business Account",
          "PHONE_NOT_FOUND"
        );
      }

      // 3. Get WhatsApp Business Account Data
      const wabaData = await this.metaPlatformService.getWhatsAppBusinessAccountData(
        whatsAppBusinessAccountId,
        accessToken
      );
      if (!wabaData) {
        this.logger.error(`WABA ${whatsAppBusinessAccountId} not found.`);
        return this.buildErrorResponse(
          400,
          "WhatsApp Business Account not found",
          "WABA_NOT_FOUND"
        );
      }

      // 4. Subscribe the App to the WABA for webhooks
      const subscribed = await this.metaPlatformService.subscribeAppToWABA(
        whatsAppBusinessAccountId,
        accessToken
      );
      if (!subscribed) {
        this.logger.error("Failed to subscribe application to WABA.");
        return this.buildErrorResponse(
          400,
          "Failed to subscribe application to WhatsApp Business Account for webhooks",
          "APP_SUBSCRIBE_FAIL"
        );
      }

      // 5. Create the Integration record in your system
      const webhookToken = uuidv4(); // Generate a unique token for webhook verification
      const integrationId = uuidv4();
      const now = Date.now();

      const integration: Integration = {
        id: integrationId,
        agentId,
        name: phoneData.verified_name || phoneData.display_phone_number,
        description: `WhatsApp integration for agent ${agentId} with phone number ${phoneData.display_phone_number} and WABA ${whatsAppBusinessAccountId}`,
        type: IntegrationType.MESSAGING,
        provider: "whatsapp",
        config: JSON.stringify({
          phoneNumberId: phoneData.id,
          businessAccountId: wabaData.id, // Use WABA ID from Meta API response
          accessToken, // User Access Token (long-lived)
          webhookVerifyToken: webhookToken,
          phoneNumber: phoneData.display_phone_number,
          displayName: phoneData.verified_name || phoneData.display_phone_number,
          platformManaged: true, // Indicate this integration was set up via Embedded Signup
          userAccessTokenExpiresAt,
        } as IntegrationWhatsAppConfig),
        credentials: accessToken, // Store token (consider encryption in production)
        status: IntegrationStatus.ACTIVE, // Mark as active if setup is complete
        createdBy: userId,
        createdAt: now,
        isActive: true,
      };

      await this.tableClient.createEntity({
        partitionKey: agentId, // Using agentId as PartitionKey
        rowKey: integrationId,
        ...integration,
      });

      // 6. Return success response
      this.logger.info(`WhatsApp integration ${integrationId} created successfully via Embedded Signup for agent ${agentId}.`);
      return {
        status: 201,
        jsonBody: {
          integrationId,
          name: integration.name,
          phoneNumber: phoneData.display_phone_number,
          status: IntegrationStatus.ACTIVE,
          message: "WhatsApp integration created successfully via Embedded Signup.",
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Error in handleEmbeddedSignupCode: ${msg}`, err);
      // Ensure specific API errors from MetaPlatformService are propagated as custom errors
      // rather than generic 500 if possible.
      if (err && typeof err === 'object' && 'statusCode' in err) {
        return {
          status: (err as any).statusCode,
          jsonBody: { error: (err as any).message, details: (err as any).details }
        };
      }
      return {
        status: 500,
        jsonBody: {
          error: "Internal server error during Embedded Signup",
          code: "UNEXPECTED_ERROR",
          details: msg,
        },
      };
    }
  }

  private buildErrorResponse(
    status: number,
    error: string,
    code: string,
    details?: string
  ): HttpResponseInit {
    return {
      status,
      jsonBody: {
        error,
        code,
        ...(details && { details }),
      },
    };
  }
}