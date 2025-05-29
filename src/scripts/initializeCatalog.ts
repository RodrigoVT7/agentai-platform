// src/scripts/initializeCatalog.ts

import { TableClient, TableServiceClient } from "@azure/data-tables";
import { IntegrationType, CapabilityToolDefinition, IntegrationCatalogItem } from "../shared/models/integration.model"; 
import { GOOGLE_CALENDAR_CONFIG } from "../shared/constants"; // Corregido: Importar desde constants
import { v4 as uuidv4 } from "uuid";
import { STORAGE_TABLES } from "../shared/constants";

const TABLE_NAME = STORAGE_TABLES.INTEGRATION_CATALOG;

async function initializeCatalog() {
  console.log(`Inicializando catálogo de integraciones en tabla: ${TABLE_NAME}...`);

  const connectionString = process.env.AzureWebJobsStorage
  if (!connectionString) {
    console.error("Error: Variable de entorno AzureWebJobsStorage es requerida.");
    process.exit(1); 
  }
  console.log("Cadena de conexión encontrada.");

  const tableServiceClient = TableServiceClient.fromConnectionString(connectionString);

  try {
    await tableServiceClient.createTable(TABLE_NAME);
    console.log(`Tabla ${TABLE_NAME} creada.`);
  } catch (error: any) {
    if (error.statusCode === 409) {
      console.log(`Tabla ${TABLE_NAME} ya existe.`);
    } else {
      console.error(`Error al intentar crear tabla ${TABLE_NAME}:`, error);
      return; 
    }
  }

  const tableClient = TableClient.fromConnectionString(connectionString, TABLE_NAME);
  console.log(`Cliente para tabla ${TABLE_NAME} obtenido.`);

  const integrations: IntegrationCatalogItem[] = [
    {
      id: 'INTEGRATION_GOOGLE_CALENDAR', 
      name: "Google Calendar",
      description: "Permite interactuar con Google Calendar para leer, crear, modificar y eliminar eventos. Puede añadir videollamadas de Google Meet y controlar las notificaciones por correo. El usuario puede gestionar las citas que él mismo haya agendado.",
      type: IntegrationType.CALENDAR,
      provider: "google",
      icon: "google_calendar_icon.png", 
      capabilityTools: [
        {
          capabilityId: "createEvent",
          toolName: "createGoogleCalendarEvent",
          description: "Crea un nuevo evento en Google Calendar. Requiere título (summary) y fecha/hora de inicio (start). Puede incluir opcionalmente fin (end), ubicación, descripción, asistentes (por email), si se debe añadir una videollamada de Google Meet, y cómo enviar notificaciones por correo.",
          parametersSchema: {
            type: "object",
            properties: {
              summary: { type: "string", description: "El título o asunto principal del evento." },
              start: {
                type: "object",
                description: "La fecha y hora de inicio del evento. Incluye 'dateTime' (ISO 8601 ej: '2025-05-10T09:00:00-06:00') y 'timeZone' (ej: 'America/Mexico_City'). Para eventos de todo el día, usa 'date' (ej: '2025-05-10').",
                properties: {
                  dateTime: { type: "string", description: "Fecha y hora ISO 8601 para eventos con hora específica." },
                  date: { type: "string", description: "Fecha en formato Plymouth-MM-DD para eventos de todo el día." },
                  timeZone: { type: "string", description: "Zona horaria IANA (opcional, se infiere si no se provee)." }
                },
              },
              end: {
                type: "object",
                description: "La fecha y hora de fin del evento. Mismo formato que 'start'. Si no se proporciona para eventos con hora, se asume una duración predeterminada.",
                 properties: {
                  dateTime: { type: "string", description: "Fecha y hora ISO 8601 para eventos con hora específica." },
                  date: { type: "string", description: "Fecha en formato Plymouth-MM-DD para eventos de todo el día." },
                  timeZone: { type: "string", description: "Zona horaria IANA (opcional, se infiere si no se provee)." }
                },
              },
              location: { type: "string", description: "La ubicación física o virtual (opcional)." },
              description: { type: "string", description: "Una descripción más detallada (opcional)." },
              attendees: {
                type: "array", description: "Lista de emails de los invitados (opcional).",
                items: { type: "object", properties: { email: { type: "string", format: "email" } }, required: ["email"] }
              },
              addConferenceCall: { 
                type: "boolean", 
                description: "Opcional. Especifica si se debe añadir una videollamada de Google Meet al evento. Por defecto es false." 
              },
              sendNotifications: { 
                type: "string", 
                description: "Opcional. Controla el envío de notificaciones por correo a los asistentes. Valores: 'all', 'externalOnly', 'none', 'default'. 'default' usa el comportamiento de Google Calendar.", 
                enum: ["all", "externalOnly", "none", "default"] 
              }
            },
            required: ["summary", "start"],
          } as CapabilityToolDefinition['parametersSchema']
        },
        {
          capabilityId: "getEvents",
          toolName: "getGoogleCalendarEvents",
          description: "Obtiene una lista de eventos del Google Calendar configurado para el agente, dentro de un rango de fechas. Esta herramienta es para uso general del agente, no para las citas específicas de un usuario.",
          parametersSchema: {
             type: "object",
             properties: {
                 timeMin: { type: "string", format:"date-time", description: "Fecha/hora ISO 8601 de inicio del rango (Opcional, defecto: inicio del día actual)." },
                 timeMax: { type: "string", format:"date-time", description: "Fecha/hora ISO 8601 de fin del rango (Opcional, defecto: fin del día actual o +30 días)." },
                 maxResults: {type: "number", description: "Máximo de eventos a devolver (Opcional, defecto 10)."}
             },
             required: []
          } as CapabilityToolDefinition['parametersSchema']
        },
        { 
          capabilityId: "updateEvent",
          toolName: "updateGoogleCalendarEvent",
          description: "Modifica un evento existente en Google Calendar que el usuario haya agendado previamente. Requiere el ID del evento y los campos a cambiar.",
          parametersSchema: { 
            type: "object",
            properties: {
              eventId: { type: "string", description: "El ID único del evento que se desea modificar." },
              summary: { type: "string", description: "El nuevo título o asunto del evento (opcional)." },
              start: { 
                type: "object",
                description: "La nueva fecha/hora de inicio (opcional). Mismo formato que createGoogleCalendarEvent.",
                properties: {
                  dateTime: { type: "string", description: "Fecha y hora ISO 8601." },
                  date: { type: "string", description: "Fecha Plymouth-MM-DD para todo el día." },
                  timeZone: { type: "string", description: "Zona horaria IANA." }
                }
              },
              end: { 
                type: "object",
                description: "La nueva fecha/hora de fin (opcional). Mismo formato que createGoogleCalendarEvent.",
                properties: {
                  dateTime: { type: "string", description: "Fecha y hora ISO 8601." },
                  date: { type: "string", description: "Fecha Plymouth-MM-DD para todo el día." },
                  timeZone: { type: "string", description: "Zona horaria IANA." }
                }
              },
              location: { type: "string", description: "La nueva ubicación (opcional)." },
              description: { type: "string", description: "La nueva descripción (opcional)." },
              attendees: {
                type: "array", description: "La nueva lista completa de emails de invitados (opcional).",
                items: { type: "object", properties: { email: { type: "string", format: "email" } }, required: ["email"] }
              },
              addConferenceCall: { type: "boolean", description: "Opcional. Especifica si se debe añadir o quitar una videollamada de Google Meet." },
              sendNotifications: { type: "string", description: "Opcional. Controla el envío de notificaciones. Valores: 'all', 'externalOnly', 'none', 'default'.", enum: ["all", "externalOnly", "none", "default"] }
            },
            required: ["eventId"], 
          } as CapabilityToolDefinition['parametersSchema']
        },
        { 
          capabilityId: "deleteEvent",
          toolName: "deleteGoogleCalendarEvent",
          description: "Elimina (cancela) un evento existente del Google Calendar que el usuario haya agendado previamente. Requiere el ID del evento.",
          parametersSchema: {
            type: "object",
            properties: {
              eventId: { type: "string", description: "El ID único del evento que se desea eliminar." },
              sendNotifications: { type: "string", description: "Opcional. Controla si se envían notificaciones de cancelación. Valores: 'all', 'externalOnly', 'none', 'default'. Por defecto, Google suele enviar.", enum: ["all", "externalOnly", "none", "default"] }
            },
            required: ["eventId"],
          } as CapabilityToolDefinition['parametersSchema']
        },
        { 
          capabilityId: "getMyBookedEvents",
          toolName: "getMyBookedCalendarEvents",
          description: "Consulta y devuelve una lista de los próximos eventos que el usuario actual agendó a través de esta conversación o agente. Puede filtrar por un rango de fechas.",
          parametersSchema: {
            type: "object",
            properties: {
              timeMin: { type: "string", format:"date-time", description: "Opcional. Fecha/hora ISO 8601 de inicio del rango para buscar citas (ej: '2025-05-23T00:00:00-06:00'). Si no se provee, se buscan desde el inicio de los tiempos." },
              timeMax: { type: "string", format:"date-time", description: "Opcional. Fecha/hora ISO 8601 de fin del rango (ej: '2025-05-30T23:59:59-06:00'). Si no se provee, se buscan hasta un año en el futuro." }
            },
            required: []
          } as CapabilityToolDefinition['parametersSchema']
        }
      ],
      requiresAuth: true, 
      setupGuide: "Requiere conexión con cuenta de Google y permisos de calendario. El usuario puede gestionar sus propias citas agendadas a través del agente.",
      configSchema: {} 
    },
    {
      id: 'INTEGRATION_WHATSAPP', 
      name: "WhatsApp",
      description: "Permite enviar mensajes a usuarios a través de la API de WhatsApp Business.",
      type: IntegrationType.MESSAGING,
      provider: "whatsapp",
      icon: "whatsapp_icon.png",
      capabilityTools: [
          {
              capabilityId: "sendMessage", 
              toolName: "sendWhatsAppTextMessage", 
              description: "Envía un mensaje de texto simple a un número de teléfono vía WhatsApp. Útil para respuestas directas.",
              parametersSchema: {
                  type: "object",
                  properties: {
                      to: { type: "string", description: "El número de teléfono completo del destinatario, incluyendo código de país (ej: 521XXXXXXXXXX para México móvil)." },
                      body: { type: "string", description: "El contenido del mensaje de texto que se enviará." }
                  },
                  required: ["to", "body"]
              } as CapabilityToolDefinition['parametersSchema']
          },
          {
              capabilityId: "sendTemplate",
              toolName: "sendWhatsAppTemplateMessage",
              description: "Envía un mensaje basado en una plantilla pre-aprobada por Meta a un número de teléfono vía WhatsApp. Necesario para iniciar conversaciones o enviar notificaciones fuera de la ventana de 24 horas.",
              parametersSchema: {
                  type: "object",
                  properties: {
                      to: { type: "string", description: "El número de teléfono completo del destinatario (ej: 521XXXXXXXXXX)." },
                      templateName: { type: "string", description: "El nombre exacto de la plantilla aprobada en Meta Business Manager." },
                      languageCode: { type: "string", description: "El código del idioma de la plantilla (ej: 'es', 'en_US', 'es_MX')." },
                      componentsJson: { type: "string", description: "(Avanzado) Un string JSON que representa la estructura de 'components' según la API de WhatsApp. Usado para llenar variables en encabezado, cuerpo o botones. Ejemplo: '[{\"type\":\"body\",\"parameters\":[{\"type\":\"text\",\"text\":\"ValorVariable1\"}]}]'." }
                  },
                  required: ["to", "templateName", "languageCode"]
              } as CapabilityToolDefinition['parametersSchema']
          }
      ],
      requiresAuth: true, 
      setupGuide: "Requiere configuración en Meta Developer Portal (App, WhatsApp Business API, Webhook).",
      configSchema: {} 
    },
    {
      id: 'SYSTEM_HANDOFF_TOOL', 
      name: "Handoff a Agente Humano",
      description: "Permite al bot escalar la conversación actual a un agente humano para asistencia especializada.",
      type: IntegrationType.SYSTEM_INTERNAL, 
      provider: "system", 
      icon: "system_handoff_icon.png", 
      capabilityTools: [
        {
          capabilityId: "initiateHandoff", 
          toolName: "requestHumanAgent",   
          description: "Escala la conversación actual a un agente humano. Usar esta herramienta cuando el usuario solicite explícitamente hablar con una persona, o cuando el bot no pueda resolver la consulta después de intentos razonables y se requiera asistencia humana. Ejemplos de frases del usuario: 'Quiero hablar con un humano', 'Necesito un agente', 'Ayuda de una persona'.",
          parametersSchema: {
            type: "object",
            properties: {
              reason: { 
                type: "string", 
                description: "La razón por la cual se solicita el handoff (opcional). El bot puede inferir esto de la conversación si no se proporciona explícitamente por el usuario." 
              }
            },
            required: [] 
          } as CapabilityToolDefinition['parametersSchema'] 
        }
      ],
      requiresAuth: false, 
      setupGuide: "Herramienta interna del sistema para la funcionalidad de handoff. No requiere configuración externa.",
      configSchema: {} 
    },
  ];

  console.log(`Iniciando inserción/actualización de ${integrations.length} definiciones de integración...`);
  let successCount = 0;
  let errorCount = 0;

  for (const integration of integrations) {
    const entity = {
      partitionKey: integration.type, 
      rowKey: integration.id, 
      name: integration.name,
      description: integration.description,
      type: integration.type,
      provider: integration.provider,
      icon: integration.icon,
      capabilityTools: JSON.stringify(integration.capabilityTools),
      requiresAuth: integration.requiresAuth,
      setupGuide: integration.setupGuide,
      configSchema: JSON.stringify(integration.configSchema) 
    };

    try {
      await tableClient.upsertEntity(entity, "Replace");
      console.log(`  ✓ Integración ${integration.name} (${integration.provider}) guardada/actualizada.`);
      successCount++;
    } catch (error: any) {
      console.error(`  ✗ Error al guardar/actualizar integración ${integration.name}:`, error);
      errorCount++;
    }
  }

  console.log("--------------------------------------------------");
  console.log(`Inicialización del catálogo completada.`);
  console.log(`  Éxitos: ${successCount}`);
  console.log(`  Errores: ${errorCount}`);
  console.log("--------------------------------------------------");
}

if (require.main === module) {
  initializeCatalog().catch(error => {
    console.error("Falló la inicialización del catálogo de integraciones:", error);
    process.exit(1);
  });
} else {
   console.log("Script initializeCatalog cargado como módulo.");
}