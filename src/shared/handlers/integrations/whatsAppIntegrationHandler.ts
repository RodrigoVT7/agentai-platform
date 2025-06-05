// src/shared/handlers/integrations/whatsAppIntegrationHandler.ts
import { v4 as uuidv4 } from "uuid";
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES, STORAGE_QUEUES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
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
} from "../../models/conversation.model"; // Asegúrate que estén importados
import { MessageReceiverHandler } from "../conversation/messageReceiverHandler"; // Importar el handler

export class WhatsAppIntegrationHandler {
  private storageService: StorageService;
  private logger: Logger;

  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
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
        const response = await fetch(
          `https://graph.facebook.com/v18.0/${config.phoneNumberId}?fields=verified_name,quality_rating,display_phone_number`,
          {
            headers: {
              Authorization: `Bearer ${config.accessToken}`,
            },
          }
        );

        if (!response.ok) {
          // Si hay problema con la API, actualizar estado de la integración
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
              message: "Error al conectar con la API de WhatsApp",
              lastCheck: Date.now(),
            },
          };
        }

        const data = await response.json();

        // Si todo está bien, actualizar estado si es necesario
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
            phone: data.display_phone_number,
            name: data.verified_name,
            qualityRating: data.quality_rating,
            lastCheck: Date.now(),
          },
        };
      } catch (error) {
        this.logger.error(
          `Error al verificar estado de WhatsApp para ${integrationId}:`,
          error
        );

        // Actualizar estado a ERROR
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
            message: "Error al verificar estado",
            lastCheck: Date.now(),
          },
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

      // Validar conexión con WhatsApp
      try {
        const response = await fetch(
          `https://graph.facebook.com/v18.0/${phoneNumberId}?fields=verified_name,display_phone_number`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
          }
        );

        if (!response.ok) {
          return {
            status: 400,
            jsonBody: {
              error: "Credenciales inválidas para WhatsApp",
              apiError: await response.text(),
            },
          };
        }
      } catch (error) {
        return {
          status: 400,
          jsonBody: {
            error: "Error al verificar credenciales de WhatsApp",
            details: error instanceof Error ? error.message : String(error),
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
        phoneNumber,
        displayName: displayName || name,
      };

      // Crear nueva integración
      const integration: Integration = {
        id: integrationId,
        agentId,
        name,
        description: `Integración con WhatsApp para el número ${phoneNumber}`,
        type: IntegrationType.MESSAGING,
        provider: "whatsapp",
        config: JSON.stringify(config),
        credentials: accessToken, // En producción, encriptar
        status: IntegrationStatus.CONFIGURED,
        createdBy: userId,
        createdAt: now,
        isActive: true,
      };

      // Guardar en Table Storage
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
          phoneNumber,
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
    messageData: {
      // Tipo más específico para los datos del mensaje
      integrationId: string;
      to: string; // Número del destinatario
      type: "text" | "template" | "image" | "document" | "interactive"; // Tipos soportados
      // Contenido varía según el tipo
      text?: { body: string; preview_url?: boolean };
      template?: {
        name: string;
        language: { code: string };
        components?: any[];
      };
      image?: { id?: string; link?: string; caption?: string }; // ID si ya está subida, link si es URL
      document?: {
        id?: string;
        link?: string;
        caption?: string;
        filename?: string;
      };
      interactive?: any; // Objeto complejo para botones/listas
      internalMessageId?: string; // ID de nuestro sistema para logging/status
    },
    userId: string // ID del usuario de nuestra plataforma (para verificación de permisos)
  ): Promise<HttpResponseInit> {
    try {
      const { integrationId, to, type, internalMessageId } = messageData;

      // 1. Verificar Integración y Permisos (como antes)
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

      // 2. Obtener Configuración
      const config = JSON.parse(
        integration.config as string
      ) as IntegrationWhatsAppConfig;

      // 3. Construir Payload para la API de WhatsApp
      const payload: any = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: to, // Número del destinatario
        type: type,
      };

      // Añadir el objeto específico según el tipo
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
          // Se requiere filename si se usa link
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
          payload.interactive = messageData.interactive; // Asume que ya tiene el formato correcto
          break;
        // Añadir más tipos según sea necesario (audio, video, location, etc.)
        default:
          return {
            status: 400,
            jsonBody: {
              error: `Tipo de mensaje no soportado para envío: ${type}`,
            },
          };
      }

      // 4. Enviar Petición a la API Graph de Meta
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
            Authorization: `Bearer ${config.accessToken}`,
          },
          body: JSON.stringify(payload),
        }
      );

      // 5. Manejar Respuesta de la API
      const responseBody = await response.json(); // Leer cuerpo de respuesta independientemente del status
      if (!response.ok) {
        this.logger.error(
          `Error al enviar mensaje WA (${response.status}): ${JSON.stringify(
            responseBody
          )}`
        );
        // Opcional: Actualizar estado del mensaje interno a FAILED si se proporcionó internalMessageId
        if (internalMessageId) {
          // await this.updateInternalMessageStatus(internalMessageId, conversationId, MessageStatus.FAILED, responseBody); // Necesitarías conversationId
        }
        return {
          status: 400, // O response.status si quieres propagar el error exacto
          jsonBody: {
            error: "Error al enviar mensaje a WhatsApp",
            apiError: responseBody, // Devolver el error de la API
          },
        };
      }

      this.logger.info(
        `Respuesta de envío WA: ${JSON.stringify(responseBody)}`
      );
      const waMessageId = responseBody.messages?.[0]?.id; // Obtener el ID del mensaje de WhatsApp

      // 6. Registrar Éxito y Devolver Respuesta
      this.logMessageSent(
        integration.agentId,
        integrationId,
        to,
        type,
        waMessageId || "N/A"
      );

      // Opcional: Actualizar mensaje interno con waMessageId en metadata
      if (internalMessageId && waMessageId) {
        // await this.updateInternalMessageMetadata(internalMessageId, conversationId, { whatsapp: { waMessageId } }); // Necesitarías conversationId
      }

      return {
        status: 200,
        jsonBody: {
          success: true,
          to: to,
          type: type,
          waMessageId: waMessageId, // Devolver el ID de WhatsApp
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
    this.logger.info(`Procesando webhook: ${JSON.stringify(webhookData)}`); // Log detallado

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

          // Encontrar la integración activa para este número
          const integration = await this.findIntegrationByPhoneNumberId(
            phoneNumberId
          );
          if (!integration) {
            this.logger.warn(
              `Webhook recibido para un número no configurado o inactivo: ${phoneNumberId}`
            );
            continue; // Ignorar si no hay integración activa
          }

          // --- Procesar Mensajes Entrantes ---
          if (messages && messages.length > 0) {
            const contact =
              contacts && contacts.length > 0 ? contacts[0] : null;
            for (const message of messages) {
              await this.processIncomingMessage(integration, message, contact);
            }
          }

          // --- Procesar Actualizaciones de Estado ---
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
      // No lanzar error para que WhatsApp no reintente indefinidamente
    }
  }

  private async processStatusUpdate(
    integration: Integration,
    statusUpdate: any
  ): Promise<void> {
    const messageId = statusUpdate.id; // ID del mensaje de WhatsApp que enviamos
    const status = statusUpdate.status; // sent, delivered, read, failed
    const timestamp = parseInt(statusUpdate.timestamp) * 1000;
    const recipientId = statusUpdate.recipient_id; // Número del destinatario

    this.logger.info(
      `Actualización de estado recibida para mensaje WA ${messageId}: ${status}`
    );

    try {
      const messagesTableClient = this.storageService.getTableClient(
        STORAGE_TABLES.MESSAGES
      );

      // Buscar el mensaje en nuestra tabla usando el ID de WhatsApp (almacenado en metadata)
      // Esto requiere que guardes `waMessageId` en los metadatos al enviar
      // Consulta más compleja, podría ser lenta si hay muchos mensajes.
      // Alternativa: Usar `messageId` interno si lo devuelves al enviar y lo mapeas.
      const filter = `metadata/whatsapp/waMessageId eq '${messageId}'`; // Asumiendo que guardas el ID de WA así
      const messages = messagesTableClient.listEntities({
        queryOptions: { filter },
      });

      let foundMessage = false;
      for await (const message of messages) {
        foundMessage = true;
        const internalMessageId = message.rowKey as string;
        const conversationId = message.partitionKey as string;

        let newStatus: MessageStatus;
        switch (status) {
          case "sent":
            newStatus = MessageStatus.SENT;
            break;
          case "delivered":
            newStatus = MessageStatus.DELIVERED;
            break;
          case "read":
            newStatus = MessageStatus.READ;
            break;
          case "failed":
            newStatus = MessageStatus.FAILED;
            break;
          default:
            newStatus = message.status as MessageStatus; // No cambiar si es desconocido
        }

        // Actualizar solo si el nuevo estado es "posterior" al actual
        const statusOrder = [
          MessageStatus.SENT,
          MessageStatus.DELIVERED,
          MessageStatus.READ,
        ];
        const currentStatusIndex = statusOrder.indexOf(
          message.status as MessageStatus
        );
        const newStatusIndex = statusOrder.indexOf(newStatus);

        if (
          newStatus === MessageStatus.FAILED ||
          newStatusIndex > currentStatusIndex
        ) {
          const updatePayload: any = {
            partitionKey: conversationId,
            rowKey: internalMessageId,
            status: newStatus,
            updatedAt: timestamp, // Usar el timestamp del evento de estado
          };
          if (status === "failed" && statusUpdate.errors) {
            updatePayload.errorMessage = JSON.stringify(
              statusUpdate.errors
            ).substring(0, 1024);
          }

          await messagesTableClient.updateEntity(updatePayload, "Merge");
          this.logger.info(
            `Estado del mensaje interno ${internalMessageId} actualizado a ${newStatus}`
          );
        } else {
          this.logger.info(
            `Estado ${status} ignorado para mensaje ${internalMessageId} (estado actual: ${message.status})`
          );
        }
        // Podríamos parar si encontramos el mensaje, asumiendo IDs únicos
        break;
      }

      if (!foundMessage) {
        this.logger.warn(
          `No se encontró el mensaje interno correspondiente al ID de WhatsApp ${messageId}`
        );
      }
    } catch (error) {
      this.logger.error(
        `Error al procesar actualización de estado para mensaje WA ${messageId}:`,
        error
      );
      // No relanzar
    }
  }

  async updateIntegration(
    integrationId: string,
    data: any,
    userId: string
  ): Promise<HttpResponseInit> {
    try {
      // Verificar si la integración existe
      const integration = await this.fetchIntegration(integrationId);

      if (!integration) {
        return {
          status: 404,
          jsonBody: { error: "Integración no encontrada" },
        };
      }

      // Verificar acceso
      const hasAccess = await this.verifyAccess(integration.agentId, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: {
            error: "No tienes permiso para modificar esta integración",
          },
        };
      }

      // Actualizar configuración
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

      // Preparar datos para actualización
      const updateData: any = {
        partitionKey: integration.agentId,
        rowKey: integrationId,
        config: updatedConfig,
        updatedAt: Date.now(),
      };

      // Si se proporciona un nuevo nombre
      if (data.name) {
        updateData.name = data.name;
      }

      // Si se proporciona nueva descripción
      if (data.description) {
        updateData.description = data.description;
      }

      // Si se proporciona nuevo token
      if (data.accessToken) {
        updateData.credentials = data.accessToken; // En producción, encriptar
      }

      // Actualizar en Table Storage
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

  // Métodos auxiliares

  private async fetchIntegration(
    integrationId: string
  ): Promise<Integration | null> {
    try {
      const tableClient = this.storageService.getTableClient(
        STORAGE_TABLES.INTEGRATIONS
      );

      // Buscar en todas las particiones
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

      // Buscar integraciones de WhatsApp
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
      // Verificar si el usuario es propietario del agente
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

      // Verificar si el usuario tiene algún rol en el agente
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
      const from = message.from; // Número del usuario
      const waMessageId = message.id; // ID del mensaje de WhatsApp
      const timestamp = parseInt(message.timestamp) * 1000; // Convertir a ms
      const profileName = contact?.profile?.name || "Usuario de WhatsApp";

      let content = "";
      let messageType: MessageType = MessageType.TEXT;
      let attachments: Record<string, any> | undefined = undefined;

      // Determinar tipo de mensaje y extraer contenido
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
          // TODO: Lógica para descargar la imagen usando el ID y accessToken
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
          // TODO: Lógica para descargar el documento
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
          // TODO: Lógica para descargar el audio
          this.logger.info(`Audio recibido: ${message.audio?.id}`);
          break;
        case "interactive":
          // Respuestas a botones o listas
          if (message.interactive?.button_reply) {
            content = message.interactive.button_reply.title; // Texto del botón
            messageType = MessageType.TEXT; // Tratar como texto
            this.logger.info(
              `Respuesta de botón recibida: ${content} (ID: ${message.interactive.button_reply.id})`
            );
          } else if (message.interactive?.list_reply) {
            content = message.interactive.list_reply.title; // Texto del item seleccionado
            messageType = MessageType.TEXT; // Tratar como texto
            this.logger.info(
              `Respuesta de lista recibida: ${content} (ID: ${message.interactive.list_reply.id})`
            );
          } else {
            this.logger.warn(
              "Mensaje interactivo desconocido:",
              message.interactive
            );
            return; // Ignorar tipos interactivos no manejados
          }
          break;
        // Añadir casos para video, location, contacts, etc. si es necesario
        default:
          this.logger.warn(
            `Tipo de mensaje de WhatsApp no manejado: ${message.type}`
          );
          return; // Ignorar tipos no soportados
      }

      if (!content && !attachments) {
        this.logger.warn(
          `Mensaje de tipo ${message.type} sin contenido procesable.`
        );
        return; // No procesar si no hay nada útil
      }

      // Preparar el MessageRequest para el bot core
      const messageRequest: MessageRequest = {
        agentId,
        content: content || `[${messageType}]`, // Contenido o placeholder
        messageType: messageType,
        sourceChannel: "whatsapp",
        // Pasamos 'userId' como null o un identificador genérico,
        // ya que MessageReceiverHandler lo buscará o creará basado en 'from'
        // Opcionalmente, podrías buscar/crear el 'endUserId' aquí
        metadata: {
          whatsapp: {
            from: from, // Número del usuario
            fromName: profileName,
            waMessageId: waMessageId, // ID del mensaje original de WA
            timestamp: timestamp,
            integrationId: integration.id,
          },
          // Puedes añadir otros metadatos aquí si son relevantes
          attachments: attachments, // Incluir IDs de media si existen
        },
      };

      // Usar MessageReceiverHandler para procesar el mensaje
      // NOTA: MessageReceiverHandler necesita ser capaz de manejar mensajes
      // sin un 'userId' preexistente, identificando/creando al usuario final
      // basado en 'messageRequest.metadata.whatsapp.from'.
      const messageReceiverHandler = new MessageReceiverHandler(this.logger);

      // Idealmente, MessageReceiverHandler debería aceptar metadatos para buscar/crear
      // el usuario final y la conversación. Asumimos que puede hacerlo.
      // Puede que necesites ajustar MessageReceiverHandler.
      // Aquí pasamos un userId placeholder o nulo si tu handler lo requiere.
      // Lo más robusto sería que el handler usara 'from' para gestionar al usuario final.
      const placeholderUserId = `whatsapp:${from}`; // Ejemplo de ID de usuario final

      // Ejecutar el handler (asumiendo que maneja la creación/búsqueda de conversación)
      await messageReceiverHandler.execute(messageRequest, placeholderUserId);

      this.logger.info(
        `Mensaje entrante de WhatsApp ${waMessageId} procesado y encolado.`
      );
    } catch (error) {
      this.logger.error(
        `Error al procesar mensaje entrante de WhatsApp ${message?.id}:`,
        error
      );
      // No relanzar para evitar reintentos de WhatsApp
    }
  }
}
