// src/shared/handlers/integrations/integrationExecutorHandler.ts (CORREGIDO)

import { v4 as uuidv4 } from "uuid"; // <--- CORRECCIÓN: Importar uuidv4
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES, STORAGE_QUEUES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError, toAppError } from "../../utils/error.utils"; // <-- CORRECCIÓN: Importar toAppError
import { Integration, IntegrationStatus, IntegrationAction, IntegrationType } from "../../models/integration.model";
import { HttpResponseInit } from "@azure/functions";
import fetch from "node-fetch";

// Importa TODOS los handlers específicos que este ejecutor podría necesitar llamar
import { GoogleCalendarHandler } from "./googleCalendarHandler";
import { WhatsAppIntegrationHandler } from "./whatsAppIntegrationHandler";
import { MicrosoftGraphHandler } from "./microsoftGraphHandler";
import { ERPConnectorHandler } from "./erpConnectorHandler";
// Asegúrate de importar cualquier otro handler de integración que implementes

export class IntegrationExecutorHandler {
  private storageService: StorageService;
  private logger: Logger;

  // Instancias de los handlers específicos para llamar a sus métodos
  private googleCalendarHandler: GoogleCalendarHandler;
  private whatsAppHandler: WhatsAppIntegrationHandler;
  private microsoftGraphHandler: MicrosoftGraphHandler;
  private erpConnectorHandler: ERPConnectorHandler;
  // Añade instancias para otros handlers si los tienes

  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();

    // Instanciar todos los handlers específicos en el constructor
    this.googleCalendarHandler = new GoogleCalendarHandler(this.logger);
    this.whatsAppHandler = new WhatsAppIntegrationHandler(this.logger);
    this.microsoftGraphHandler = new MicrosoftGraphHandler(this.logger);
    this.erpConnectorHandler = new ERPConnectorHandler(this.logger);
    // Inicializa otros handlers aquí
  }

  /**
   * Punto de entrada principal para ejecutar una acción de integración.
   * Decide si ejecutarla síncrona o asíncronamente.
   * @param data - Los detalles de la acción a ejecutar (IntegrationAction).
   * @param requestorUserId - El ID del usuario que *inició* la solicitud.
   * @returns Resultado de la ejecución o estado 'Accepted'.
   */
  async execute(data: IntegrationAction, requestorUserId: string): Promise<any> {
    const { integrationId, action, parameters, async = false } = data;
    const endUserId = data.userId; // ID del usuario final (si se pasó)
    let integration: Integration | null = null;

    try {
      integration = await this.fetchIntegration(integrationId);
      if (!integration) {
        throw createAppError(404, `Integración no encontrada con ID: ${integrationId}`);
      }

      if (integration.status !== IntegrationStatus.ACTIVE || !integration.isActive) {
        throw createAppError(400, `La integración '${integration.name}' (ID: ${integrationId}) no está activa. Estado: ${integration.status}, isActive: ${integration.isActive}`);
      }

      if (async) {
        const queueMessage = { ...data, userIdForQueueProcessing: endUserId || requestorUserId };
        const queueClient = this.storageService.getQueueClient(STORAGE_QUEUES.INTEGRATION);
        await queueClient.sendMessage(Buffer.from(JSON.stringify(queueMessage)).toString('base64'));
        await this.logIntegrationAction(integration.agentId, integrationId, action, 'queued', endUserId || requestorUserId);
        return {
          status: 202, message: "Solicitud encolada",
          requestId: data.conversationId || data.messageId || Date.now().toString()
        };
      }

      const effectiveUserId = endUserId || requestorUserId;
      // <-- CORRECCIÓN: Pasar el objeto 'data' original a executeIntegrationAction
      const result = await this.executeIntegrationAction(integration, action, parameters, effectiveUserId, data);
      await this.logIntegrationAction(
        integration.agentId, integrationId, action,
        result.success ? 'success' : 'error', effectiveUserId,
        !result.success ? result.error : undefined
      );
      return result;

    } catch (error) {
      this.logger.error(`Error en IntegrationExecutorHandler.execute para acción '${action}' en integración ${integrationId}:`, error);
      if (integration) {
        await this.logIntegrationAction(
            integration.agentId, integrationId, action, 'error',
            endUserId || requestorUserId, error instanceof Error ? error.message : String(error)
        );
      }
      const appError = toAppError(error);
      return { success: false, error: appError.message, details: appError.details, statusCode: appError.statusCode };
    }
  }

  /**
   * Procesa un mensaje de la cola de integración (ejecución asíncrona).
   * @param message - El mensaje deserializado de la cola (debería ser tipo IntegrationAction).
   */
  async executeFromQueue(message: any): Promise<void> { // message debería ser IntegrationAction
    const { integrationId, action, parameters } = message;
    const userIdForPermCheck = message.userIdForQueueProcessing || message.userId; // El ID relevante guardado en la cola
    let integration: Integration | null = null;

    try {
        integration = await this.fetchIntegration(integrationId);
        if (!integration) {
            throw new Error(`Integración no encontrada desde cola: ${integrationId}`);
        }

        if (integration.status !== IntegrationStatus.ACTIVE || !integration.isActive) {
            this.logger.warn(`Integración ${integrationId} no está activa, saltando ejecución desde cola.`);
            return;
        }

        // <-- CORRECCIÓN: Pasar el objeto 'message' original a executeIntegrationAction
        const result = await this.executeIntegrationAction(integration, action, parameters, userIdForPermCheck, message);

        await this.logIntegrationAction(
            integration.agentId, integrationId, action,
            result.success ? 'success' : 'error', userIdForPermCheck,
            !result.success ? result.error : undefined
        );

        if (message.callbackUrl) {
            try {
                const callbackPayload = { integrationId, action, requestId: message.conversationId || message.messageId, result };
                this.logger.info(`Enviando resultado a callback URL: ${message.callbackUrl}`);
                const response = await fetch(message.callbackUrl, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(callbackPayload)
                });
                if (!response.ok) {
                     this.logger.error(`Error en callback HTTP ${response.status} a ${message.callbackUrl}`);
                }
            } catch (callbackError) {
                this.logger.error(`Error de red al enviar resultado a callback URL ${message.callbackUrl}:`, callbackError);
            }
        }
    } catch (error) {
        this.logger.error(`Error al procesar mensaje de cola para integración ${integrationId}:`, error);
        if (integration) {
             await this.logIntegrationAction(integration.agentId, integrationId, action, 'error', userIdForPermCheck, error instanceof Error ? error.message : String(error));
        }
    }
  }


  /**
   * Delega la ejecución de la acción al handler específico basado en el tipo y proveedor.
   * @param integration - El objeto de integración completo.
   * @param action - La acción interna a realizar (ej. 'getEvents').
   * @param parameters - Los parámetros para la acción.
   * @param executingUserId - ID del usuario final o del sistema/admin que ejecuta.
   * @param originalActionData - El objeto IntegrationAction original que inició la ejecución. <-- CORRECCIÓN: Añadido parámetro
   * @returns Objeto estándar: { success: boolean, result?: any, error?: string, details?: any, statusCode?: number }
   */
  private async executeIntegrationAction(
    integration: Integration,
    action: string,
    parameters: Record<string, any>,
    executingUserId: string,
    originalActionData: IntegrationAction // <-- CORRECCIÓN: Añadido parámetro
  ): Promise<{ success: boolean, result?: any, error?: string, details?: any, statusCode?: number }> {
    try {
      const { type, provider, id: integrationId, agentId } = integration;
      const integrationKey = `${type}:${provider}`;
      let response: HttpResponseInit;

      this.logger.info(`Delegando acción '${action}' para ${integrationKey} (ID: ${integrationId})`);

      switch (integrationKey) {
        // --- Google Calendar ---
        case `${IntegrationType.CALENDAR}:google`:
          if (action === 'getEvents') {
             response = await this.googleCalendarHandler.getEvents(integrationId, executingUserId, parameters);
          } else if (action === 'createEvent') {
             response = await this.googleCalendarHandler.createEvent(integrationId, parameters, executingUserId);
          } else if (action === 'updateEvent') {
             if (!parameters.eventId) throw createAppError(400, "Falta eventId para updateEvent");
             response = await this.googleCalendarHandler.updateEvent(integrationId, parameters.eventId, parameters, executingUserId);
          } else if (action === 'deleteEvent') {
             if (!parameters.eventId) throw createAppError(400, "Falta eventId para deleteEvent");
             response = await this.googleCalendarHandler.deleteEvent(integrationId, parameters.eventId, executingUserId);
          } else {
            throw createAppError(400, `Acción Google Calendar no soportada: ${action}`);
          }
          break;

        // --- WhatsApp ---
        case `${IntegrationType.MESSAGING}:whatsapp`:
          if (action === 'sendMessage' || action === 'sendTemplate') {
              let messageType: "text" | "template" | "image" | "document" | "interactive";
              let messagePayload: any = {};

              if (action === 'sendMessage' && parameters.body) {
                  messageType = 'text';
                  messagePayload.text = { body: parameters.body };
              } else if (action === 'sendTemplate' && parameters.templateName && parameters.languageCode) {
                  messageType = 'template';
                  messagePayload.template = {
                      name: parameters.templateName,
                      language: { code: parameters.languageCode },
                      components: parameters.componentsJson ? this.tryParseJson(parameters.componentsJson) : undefined
                  };
              }
              // ... añadir otros tipos ...
              else {
                   throw createAppError(400, `Parámetros inválidos o acción no mapeada para WhatsApp: ${action}`);
              }

              const messageData = {
                   integrationId: integrationId,
                   to: parameters.to,
                   type: messageType,
                   ...messagePayload,
                   // <-- CORRECCIÓN: Usar originalActionData
                   internalMessageId: originalActionData.messageId
              };

              if (!messageData.to) throw createAppError(400, "Falta destinatario 'to' para acción WhatsApp");

              response = await this.whatsAppHandler.sendMessage(messageData, executingUserId);
          } else {
            throw createAppError(400, `Acción WhatsApp no soportada: ${action}`);
          }
          break;

        // --- Microsoft Graph (Calendar & Email) ---
        case `${IntegrationType.CALENDAR}:microsoft`:
        case `${IntegrationType.EMAIL}:microsoft`:
           const serviceType = type === IntegrationType.CALENDAR ? 'calendar' : 'email';
           if (action === 'getEvents' && serviceType === 'calendar') {
               response = await this.microsoftGraphHandler.getEvents(integrationId, executingUserId, parameters);
           } else if (action === 'createEvent' && serviceType === 'calendar') {
               response = await this.microsoftGraphHandler.createEvent(integrationId, parameters, executingUserId);
           } else if (action === 'updateEvent' && serviceType === 'calendar') {
               if (!parameters.eventId) throw createAppError(400, "Falta eventId para updateEvent (Microsoft)");
               response = await this.microsoftGraphHandler.updateEvent(integrationId, parameters.eventId, parameters, executingUserId);
           } else if (action === 'deleteEvent' && serviceType === 'calendar') {
               if (!parameters.eventId) throw createAppError(400, "Falta eventId para deleteEvent (Microsoft)");
               response = await this.microsoftGraphHandler.deleteEvent(integrationId, parameters.eventId, executingUserId);
           } else if (action === 'sendMail' && serviceType === 'email') {
                response = await this.microsoftGraphHandler.sendMail(integrationId, parameters, executingUserId);
           } else if (action === 'getMail' && serviceType === 'email') {
                 const mailOptions = { folder: parameters.folder || 'inbox', limit: parameters.limit || 10 };
                 response = await this.microsoftGraphHandler.getMail(integrationId, executingUserId, mailOptions);
           } else {
               throw createAppError(400, `Acción Microsoft Graph (${serviceType}) no soportada: ${action}`);
           }
           break;

        // --- ERP ---
         case `${IntegrationType.ERP}:sap`:
         case `${IntegrationType.ERP}:dynamics`:
         case `${IntegrationType.ERP}:odoo`:
         case `${IntegrationType.ERP}:generic`:
             if (action === 'queryData') {
                  if (!parameters.entity && !parameters.query) throw createAppError(400, "Falta 'entity' o 'query' para queryData ERP");
                  const queryOptions = { filter: parameters.filter, limit: parameters.limit || 10 };
                  response = await this.erpConnectorHandler.queryData(integrationId, parameters.entity || parameters.query, executingUserId, queryOptions);
             } else if (action === 'createRecord') {
                 if (!parameters.entity || !parameters.data) throw createAppError(400, "Falta 'entity' o 'data' para createRecord ERP");
                  response = await this.erpConnectorHandler.createRecord(integrationId, parameters.entity, parameters.data, executingUserId);
             } else if (action === 'updateRecord') {
                 if (!parameters.entity || !parameters.recordId || !parameters.data) throw createAppError(400, "Falta 'entity', 'recordId' o 'data' para updateRecord ERP");
                 response = await this.erpConnectorHandler.updateRecord(integrationId, parameters.entity, parameters.recordId, parameters.data, executingUserId);
             } else if (action === 'deleteRecord') {
                  if (!parameters.entity || !parameters.recordId) throw createAppError(400, "Falta 'entity' o 'recordId' para deleteRecord ERP");
                 response = await this.erpConnectorHandler.deleteRecord(integrationId, parameters.entity, parameters.recordId, executingUserId);
             } else if (action === 'executeQuery') {
                 if (!parameters.query && !parameters.sql) throw createAppError(400, "Falta 'query' o 'sql' para executeQuery ERP");
                 response = await this.erpConnectorHandler.executeQuery(integrationId, parameters, executingUserId);
             }
             else {
                 throw createAppError(400, `Acción ERP no soportada: ${action}`);
             }
             break;

        default:
          this.logger.error(`Tipo/Proveedor de integración no manejado en executeIntegrationAction: ${integrationKey}`);
          throw createAppError(501, `Tipo de integración no implementado: ${integrationKey}`);
      }

      // Procesar la respuesta del handler específico
      const status = response.status || 500;
      const body = response.jsonBody;

      if (status >= 200 && status < 300) {
         this.logger.info(`Acción '${action}' para integración ${integrationId} completada con éxito (Status: ${status})`);
         return { success: true, result: body };
      } else {
         this.logger.error(`Acción '${action}' para integración ${integrationId} falló (Status: ${status})`, body);
         const errorMessage = body?.error || body?.message || `La acción falló con estado ${status}`;
         return { success: false, error: String(errorMessage), details: body?.details || body?.apiError || body, statusCode: status };
      }

    } catch (error) {
      this.logger.error(`Error fatal al ejecutar acción específica '${action}' para integración ${integration.id}:`, error);
      const appError = toAppError(error);
      return { success: false, error: appError.message, details: appError.details, statusCode: appError.statusCode };
    }
  }


  // --- Métodos privados auxiliares ---

  /**
   * Registra la ejecución de una acción en la tabla de logs.
   */
  private async logIntegrationAction(
    agentId: string,
    integrationId: string,
    action: string,
    status: 'queued' | 'success' | 'error',
    userId: string,
    errorMessage?: string
  ): Promise<void> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATION_LOGS);
      const timestamp = Date.now();
      const logEntry: any = {
        partitionKey: agentId,
        // <-- CORRECCIÓN: Usar uuidv4 importado
        rowKey: `${(9999999999999 - timestamp).toString()}_${uuidv4().substring(0, 8)}`,
        integrationId,
        action,
        status,
        executedBy: userId,
        timestamp // Usar timestamp numérico
      };
      if (status === 'error' && errorMessage) {
          logEntry.errorMessage = errorMessage.substring(0, 1024);
      }

      await tableClient.createEntity(logEntry);
    } catch (error) {
      this.logger.error(`Error al registrar acción de integración (Agent: ${agentId}, Int: ${integrationId}, Action: ${action}):`, error);
    }
  }

  /**
   * Busca una integración por su ID (RowKey) en todas las particiones.
   * Parsea la configuración JSON si existe.
   */
  private async fetchIntegration(integrationId: string): Promise<Integration | null> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
      const integrations = tableClient.listEntities({
        queryOptions: { filter: `RowKey eq '${integrationId}'` }
      });
      for await (const integration of integrations) {
        if (typeof integration.config === 'string') {
            try {
                integration.config = JSON.parse(integration.config);
            } catch (e) {
                this.logger.warn(`Error parseando config JSON para integración ${integrationId}`, e);
                integration.config = {};
            }
        } else if (integration.config === null || integration.config === undefined) {
             integration.config = {};
        }
        return integration as unknown as Integration;
      }
      this.logger.warn(`No se encontró la integración con ID: ${integrationId}`);
      return null;
    } catch (error: any) {
       if (error.statusCode !== 404) {
            this.logger.error(`Error al buscar integración ${integrationId} en Table Storage:`, error);
       }
      return null;
    }
  }

   /**
     * Intenta parsear un string JSON de forma segura.
     */
   private tryParseJson(jsonString: string | undefined | null): any | undefined {
        if (!jsonString) { return undefined; }
        try {
            return JSON.parse(jsonString);
        } catch (e) {
            this.logger.warn(`Error al parsear string JSON: "${jsonString.substring(0, 50)}..."`, e);
            return undefined;
        }
    }

}