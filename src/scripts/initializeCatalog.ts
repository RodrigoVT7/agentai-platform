import { TableClient, TableServiceClient } from "@azure/data-tables";
import { IntegrationType, CapabilityToolDefinition, IntegrationCatalogItem } from "../shared/models/integration.model"; 
import { GOOGLE_CALENDAR_CONFIG } from "../shared/constants";
import { v4 as uuidv4 } from "uuid";
import { STORAGE_TABLES } from "../shared/constants";

const TABLE_NAME = STORAGE_TABLES.INTEGRATION_CATALOG;

async function initializeCatalog() {
  console.log(`Inicializando catálogo de integraciones en tabla: ${TABLE_NAME}...`);

  const connectionString = ""
  
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
      description: "Permite interactuar con Google Calendar para leer, crear, modificar y eliminar eventos. Siempre pregunta por email y nombre del usuario antes de agendar.",
      type: IntegrationType.CALENDAR,
      provider: "google",
      icon: "google_calendar_icon.png", 
      capabilityTools: [
        {
          capabilityId: "createEvent",
          toolName: "createGoogleCalendarEvent",
          description: "Crea un nuevo evento en Google Calendar. IMPORTANTE: SIEMPRE debes obtener el email y nombre del usuario en la conversación actual antes de usar esta herramienta. NUNCA asumas que tienes esta información de conversaciones pasadas.",
          parametersSchema: {
            type: "object",
            properties: {
              summary: { 
                type: "string", 
                description: "El título del evento. Será mejorado automáticamente con el nombre del usuario." 
              },
              start: {
                type: "object",
                description: "Fecha y hora de inicio del evento.",
                properties: {
                  dateTime: { type: "string", description: "Fecha y hora ISO 8601 (ej: '2025-05-10T09:00:00-06:00')" },
                  date: { type: "string", description: "Fecha en formato YYYY-MM-DD para eventos de todo el día" },
                  timeZone: { type: "string", description: "Zona horaria IANA (opcional)" }
                }
              },
              end: {
                type: "object", 
                description: "Fecha y hora de fin del evento. Si no se proporciona, se calculará automáticamente.",
                properties: {
                  dateTime: { type: "string", description: "Fecha y hora ISO 8601" },
                  date: { type: "string", description: "Fecha en formato YYYY-MM-DD para eventos de todo el día" },
                  timeZone: { type: "string", description: "Zona horaria IANA (opcional)" }
                }
              },
              userEmail: {
                type: "string",
                description: "OBLIGATORIO. Email del usuario obtenido en ESTA conversación. Debes preguntar: '¿Cuál email prefieres usar para esta cita?' y usar la respuesta del usuario.",
                format: "email"
              },
              userName: {
                type: "string", 
                description: "OBLIGATORIO. Nombre completo del usuario obtenido en ESTA conversación. Debes preguntar: '¿Cuál es tu nombre completo?' y usar la respuesta del usuario."
              },
              location: { type: "string", description: "Ubicación del evento (opcional)" },
              description: { type: "string", description: "Descripción adicional (opcional)" },
              attendees: {
                type: "array", 
                description: "Lista de emails de invitados adicionales (opcional).",
                items: { 
                  type: "object", 
                  properties: { 
                    email: { type: "string", format: "email" } 
                  }, 
                  required: ["email"] 
                }
              },
              addConferenceCall: { 
                type: "boolean", 
                description: "Si añadir videollamada de Google Meet (opcional, default: false)" 
              },
              sendNotifications: { 
                type: "string", 
                description: "Controla el envío de notificaciones por correo. Valores permitidos: all, externalOnly, none, default" 
              }
            },
            required: ["summary", "start", "userEmail", "userName"]
          } as CapabilityToolDefinition['parametersSchema']
        },
        {
          capabilityId: "getEvents",
          toolName: "getGoogleCalendarEvents",
          description: "Obtiene una lista de eventos del Google Calendar del agente, dentro de un rango de fechas. Para uso general del agente, no para citas específicas de usuarios.",
          parametersSchema: {
            type: "object",
            properties: {
              timeMin: { 
                type: "string", 
                description: "Fecha/hora ISO 8601 de inicio del rango (Opcional)" 
              },
              timeMax: { 
                type: "string", 
                description: "Fecha/hora ISO 8601 de fin del rango (Opcional)" 
              },
              maxResults: {
                type: "number", 
                description: "Máximo de eventos a devolver (Opcional, defecto 10)"
              }
            },
            required: []
          } as CapabilityToolDefinition['parametersSchema']
        },
       {
    capabilityId: "getMyBookedEvents",
    toolName: "getMyBookedCalendarEvents",
    description: "OBLIGATORIO USAR cuando el usuario pregunte por sus citas existentes, quiera modificar una cita, o mencione 'cambiar', 'mover', 'reagendar'. Consulta las citas que el usuario tiene agendadas vía WhatsApp. Úsala ANTES de crear citas nuevas si el usuario quiere modificar algo existente.",
    parametersSchema: {
        type: "object",
        properties: {
            timeMin: { 
                type: "string", 
                format:"date-time", 
                description: "Opcional. Fecha de inicio del rango (default: ahora)" 
            },
            timeMax: { 
                type: "string", 
                format:"date-time", 
                description: "Opcional. Fecha de fin del rango (default: 1 año futuro)" 
            }
        },
        required: []
    }
},
{
    capabilityId: "updateEvent",
    toolName: "updateGoogleCalendarEvent",
    description: "Modifica una cita existente. USA SOLO cuando el usuario quiera cambiar/mover/reagendar una cita existente. SIEMPRE usar getMyBookedCalendarEvents PRIMERO para encontrar el eventId correcto.",
    parametersSchema: { 
        type: "object",
        properties: {
            eventId: { 
                type: "string", 
                description: "OBLIGATORIO. ID del evento obtenido de getMyBookedCalendarEvents. Sin este ID NO puedes modificar la cita." 
            },
            summary: { 
                type: "string", 
                description: "Nuevo título del evento (opcional)" 
            },
            start: { 
                type: "object",
                description: "Nueva fecha/hora de inicio (opcional)",
                properties: {
                    dateTime: { type: "string", description: "Fecha y hora ISO 8601" },
                    timeZone: { type: "string", description: "Zona horaria IANA" }
                }
            },
            end: { 
                type: "object",
                description: "Nueva fecha/hora de fin (opcional)",
                properties: {
                    dateTime: { type: "string", description: "Fecha y hora ISO 8601" },
                    timeZone: { type: "string", description: "Zona horaria IANA" }
                }
            },
            location: { type: "string", description: "Nueva ubicación (opcional)" },
            description: { type: "string", description: "Nueva descripción (opcional)" }
        },
        required: ["eventId"], 
    }
},
{
    capabilityId: "deleteEvent",
    toolName: "deleteGoogleCalendarEvent",
    description: "Cancela/elimina una cita existente. USA SOLO cuando el usuario quiera cancelar una cita. SIEMPRE usar getMyBookedCalendarEvents PRIMERO para encontrar el eventId correcto.",
    parametersSchema: {
        type: "object",
        properties: {
            eventId: { 
                type: "string", 
                description: "OBLIGATORIO. ID del evento obtenido de getMyBookedCalendarEvents." 
            },
            sendNotifications: { 
                type: "string", 
                description: "Si enviar notificaciones de cancelación (default: 'all')", 
                enum: ["all", "externalOnly", "none", "default"] 
            }
        },
        required: ["eventId"],
    }
}
      ],
      requiresAuth: true, 
      setupGuide: "Requiere conexión con cuenta de Google y permisos de calendario.",
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
          description: "Envía un mensaje de texto simple a un número de teléfono vía WhatsApp.",
          parametersSchema: {
            type: "object",
            properties: {
              to: { 
                type: "string", 
                description: "El número de teléfono completo del destinatario, incluyendo código de país (ej: +521234567890)" 
              },
              body: { 
                type: "string", 
                description: "El contenido del mensaje de texto que se enviará" 
              }
            },
            required: ["to", "body"]
          } as CapabilityToolDefinition['parametersSchema']
        },
        {
          capabilityId: "sendTemplate",
          toolName: "sendWhatsAppTemplateMessage",
          description: "Envía un mensaje basado en una plantilla pre-aprobada por Meta a un número de teléfono vía WhatsApp.",
          parametersSchema: {
            type: "object",
            properties: {
              to: { 
                type: "string", 
                description: "El número de teléfono completo del destinatario (ej: +521234567890)" 
              },
              templateName: { 
                type: "string", 
                description: "El nombre exacto de la plantilla aprobada en Meta Business Manager" 
              },
              languageCode: { 
                type: "string", 
                description: "El código del idioma de la plantilla (ej: 'es', 'en_US', 'es_MX')" 
              },
              componentsJson: { 
                type: "string", 
                description: "Un string JSON que representa la estructura de 'components' según la API de WhatsApp para llenar variables en la plantilla (opcional)" 
              }
            },
            required: ["to", "templateName", "languageCode"]
          } as CapabilityToolDefinition['parametersSchema']
        },
        // CORREGIDO: sendWhatsAppImageMessage sin oneOf/anyOf/enum en el nivel superior
        {
          capabilityId: "sendImage",
          toolName: "sendWhatsAppImageMessage",
          description: "Envía una imagen a un número de teléfono vía WhatsApp. Puede usar una URL de imagen o un ID de media previamente subido.",
          parametersSchema: {
            type: "object",
            properties: {
              to: { 
                type: "string", 
                description: "El número de teléfono completo del destinatario (ej: +521234567890)" 
              },
              imageUrl: { 
                type: "string", 
                description: "URL de la imagen a enviar. Debe ser accesible públicamente y en formato JPEG, PNG o WebP" 
              },
              imageId: { 
                type: "string", 
                description: "ID de una imagen previamente subida a WhatsApp Business API. Alternativa a imageUrl" 
              },
              caption: { 
                type: "string", 
                description: "Texto opcional que acompaña a la imagen" 
              }
            },
            required: ["to"],
            // NOTA: En lugar de oneOf, usamos lógica en la descripción
            // El handler debe validar que se proporcione imageUrl O imageId
            additionalProperties: false
          } as CapabilityToolDefinition['parametersSchema']
        },
        {
          capabilityId: "sendDocument",
          toolName: "sendWhatsAppDocumentMessage", 
          description: "Envía un documento a un número de teléfono vía WhatsApp.",
          parametersSchema: {
            type: "object",
            properties: {
              to: { 
                type: "string", 
                description: "El número de teléfono completo del destinatario (ej: +521234567890)" 
              },
              documentUrl: { 
                type: "string", 
                description: "URL del documento a enviar. Debe ser accesible públicamente" 
              },
              documentId: { 
                type: "string", 
                description: "ID de un documento previamente subido. Alternativa a documentUrl" 
              },
              filename: { 
                type: "string", 
                description: "Nombre del archivo que se mostrará al usuario" 
              },
              caption: { 
                type: "string", 
                description: "Texto opcional que acompaña al documento" 
              }
            },
            required: ["to", "filename"]
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
          description: "Escala la conversación actual a un agente humano. Usar cuando el usuario solicite explícitamente hablar con una persona, o cuando el bot no pueda resolver la consulta.",
          parametersSchema: {
            type: "object",
            properties: {
              reason: { 
                type: "string", 
                description: "La razón por la cual se solicita el handoff (opcional)" 
              },
              urgency: {
                type: "string",
                description: "Nivel de urgencia del handoff. Valores: low, medium, high"
              }
            },
            required: []
          } as CapabilityToolDefinition['parametersSchema'] 
        }
      ],
      requiresAuth: false, 
      setupGuide: "Herramienta interna del sistema para handoff. No requiere configuración externa.",
      configSchema: {} 
    }
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