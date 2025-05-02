// src/scripts/initializeCatalog.ts

import { TableClient, TableServiceClient } from "@azure/data-tables";
// Asegúrate de que estas importaciones de modelos sean correctas según tu estructura
import { IntegrationType, CapabilityToolDefinition } from "../shared/models/integration.model";
import { v4 as uuidv4 } from "uuid";
// Importar constantes para nombres de tabla y la conexión
import { STORAGE_TABLES } from "../shared/constants";

const TABLE_NAME = STORAGE_TABLES.INTEGRATION_CATALOG;

async function initializeCatalog() {
  console.log(`Inicializando catálogo de integraciones en tabla: ${TABLE_NAME}...`);

  // 1. Obtener la cadena de conexión
  const connectionString = process.env.AzureWebJobsStorage ?? "";
  if (!connectionString) {
    console.error("Error: Variable de entorno AzureWebJobsStorage es requerida.");
    process.exit(1); // Salir si no hay cadena de conexión
  }
  console.log("Cadena de conexión encontrada.");

  // 2. Crear cliente de SERVICIO para operaciones a nivel de tabla
  const tableServiceClient = TableServiceClient.fromConnectionString(connectionString);

  // 3. Asegurar que la tabla exista
  try {
    await tableServiceClient.createTable(TABLE_NAME);
    console.log(`Tabla ${TABLE_NAME} creada.`);
  } catch (error: any) {
    // @ts-ignore - Acceder a statusCode si existe
    if (error.statusCode === 409) {
      console.log(`Tabla ${TABLE_NAME} ya existe.`);
    } else {
      console.error(`Error al intentar crear tabla ${TABLE_NAME}:`, error);
      return; // No continuar si hay un error creando la tabla
    }
  }

  // 4. Crear cliente de TABLA para operaciones con entidades (upsert)
  const tableClient = TableClient.fromConnectionString(connectionString, TABLE_NAME);
  console.log(`Cliente para tabla ${TABLE_NAME} obtenido.`);

  // 5. Definir las integraciones y sus herramientas/capacidades
  //    Estas definiciones le dicen al modelo de IA qué funciones puede llamar.
  const integrations = [
    // --- Google Calendar ---
    {
      // Usar un UUID fijo o generar uno nuevo cada vez. Fijo es mejor para consistencia.
      id: 'INTEGRATION_GOOGLE_CALENDAR', // ID Fijo para referencia fácil
      name: "Google Calendar",
      description: "Permite interactuar con Google Calendar para leer y crear eventos.",
      type: IntegrationType.CALENDAR,
      provider: "google",
      icon: "google_calendar_icon.png", // Puedes cambiar esto
      capabilityTools: [
        // --- Herramienta existente: Crear Evento ---
        {
          capabilityId: "createEvent",
          toolName: "createGoogleCalendarEvent",
          description: "Crea un nuevo evento en el Google Calendar del usuario. Requiere título (summary), fecha/hora de inicio (start) y fin (end). Opcionalmente puede incluir ubicación, descripción y asistentes (por email).",
          parametersSchema: {
            type: "object",
            properties: {
              summary: { type: "string", description: "El título o asunto principal del evento." },
              start: {
                type: "object",
                description: "La fecha y hora de inicio del evento. Incluye 'dateTime' (ISO 8601 ej: '2025-05-10T09:00:00-06:00') y 'timeZone' (ej: 'America/Mexico_City').",
                properties: {
                  dateTime: { type: "string", description: "Fecha y hora ISO 8601" },
                  timeZone: { type: "string", description: "Zona horaria IANA" }
                },
                required: ["dateTime", "timeZone"] // dateTime es necesario para eventos con hora
              },
              end: {
                type: "object",
                description: "La fecha y hora de fin del evento. Mismo formato que 'start'. Si no se proporciona, se asume una duración predeterminada.",
                properties: {
                  dateTime: { type: "string" },
                  timeZone: { type: "string" }
                },
                required: ["dateTime", "timeZone"]
              },
              location: { type: "string", description: "La ubicación física o virtual (opcional)." },
              description: { type: "string", description: "Una descripción más detallada (opcional)." },
              attendees: {
                type: "array", description: "Lista de emails de los invitados (opcional).",
                items: { type: "object", properties: { email: { type: "string", format: "email" } }, required: ["email"] }
              }
            },
            required: ["summary", "start"], // 'end' es opcional ahora gracias al cálculo automático
          } as CapabilityToolDefinition['parametersSchema']
        },
        // --- Herramienta existente: Obtener Eventos ---
        {
          capabilityId: "getEvents",
          toolName: "getGoogleCalendarEvents",
          description: "Obtiene una lista de eventos del Google Calendar del usuario dentro de un rango de fechas. Útil para verificar disponibilidad antes de crear o actualizar.",
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
        // --- NUEVA Herramienta: Actualizar Evento ---
        {
          capabilityId: "updateEvent",
          toolName: "updateGoogleCalendarEvent",
          description: "Modifica un evento existente en el Google Calendar. Requiere el ID del evento a modificar y al menos un campo para actualizar (summary, start, end, location, description, attendees).",
          parametersSchema: {
            type: "object",
            properties: {
              eventId: { type: "string", description: "El ID único del evento que se desea modificar." },
              summary: { type: "string", description: "El nuevo título o asunto del evento (opcional)." },
              start: {
                type: "object", description: "La nueva fecha/hora de inicio (opcional). Mismo formato que createEvent.",
                properties: { dateTime: { type: "string" }, timeZone: { type: "string" } }
              },
              end: {
                type: "object", description: "La nueva fecha/hora de fin (opcional). Mismo formato que createEvent.",
                properties: { dateTime: { type: "string" }, timeZone: { type: "string" } }
              },
              location: { type: "string", description: "La nueva ubicación (opcional)." },
              description: { type: "string", description: "La nueva descripción (opcional)." },
              attendees: {
                type: "array", description: "La nueva lista completa de emails de invitados (opcional).",
                items: { type: "object", properties: { email: { type: "string", format: "email" } }, required: ["email"] }
              }
            },
            required: ["eventId"], // Solo el ID es obligatorio para identificar el evento
          } as CapabilityToolDefinition['parametersSchema']
        },
        // --- NUEVA Herramienta: Eliminar Evento ---
        {
          capabilityId: "deleteEvent",
          toolName: "deleteGoogleCalendarEvent",
          description: "Elimina (cancela) un evento existente del Google Calendar. Requiere el ID del evento a eliminar.",
          parametersSchema: {
            type: "object",
            properties: {
              eventId: { type: "string", description: "El ID único del evento que se desea eliminar." }
            },
            required: ["eventId"],
          } as CapabilityToolDefinition['parametersSchema']
        }
      ],
      requiresAuth: true, // Necesita autenticación OAuth 2.0
      setupGuide: "Requiere conexión con cuenta de Google y permisos de calendario.",
      configSchema: {} // Esquema vacío, la configuración se guarda en 'credentials' y 'config' de la tabla 'integrations'
    },

    // --- WhatsApp ---
    {
      id: 'INTEGRATION_WHATSAPP', // ID Fijo
      name: "WhatsApp",
      description: "Permite enviar mensajes a usuarios a través de la API de WhatsApp Business.",
      type: IntegrationType.MESSAGING,
      provider: "whatsapp",
      icon: "whatsapp_icon.png",
      capabilityTools: [
          {
              capabilityId: "sendMessage", // ID interno
              toolName: "sendWhatsAppTextMessage", // Nombre para el LLM
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
                      // Los componentes son complejos, definirlos aquí puede ser extenso.
                      // Una alternativa es esperar que el LLM proporcione un JSON bien formado.
                      componentsJson: { type: "string", description: "(Avanzado) Un string JSON que representa la estructura de 'components' según la API de WhatsApp. Usado para llenar variables en encabezado, cuerpo o botones. Ejemplo: '[{\"type\":\"body\",\"parameters\":[{\"type\":\"text\",\"text\":\"ValorVariable1\"}]}]'." }
                  },
                  required: ["to", "templateName", "languageCode"]
              } as CapabilityToolDefinition['parametersSchema']
          }
          // Podrías añadir herramientas para enviar imágenes, documentos, etc., si es necesario.
      ],
      requiresAuth: true, // Necesita Access Token de la API de Meta
      setupGuide: "Requiere configuración en Meta Developer Portal (App, WhatsApp Business API, Webhook).",
      configSchema: {} // La configuración se guarda en la tabla 'integrations'
    },

    // --- Puedes añadir más integraciones aquí (Microsoft Graph, ERPs...) ---

  ];

  // 6. Insertar/Actualizar registros en la tabla
  console.log(`Iniciando inserción/actualización de ${integrations.length} definiciones de integración...`);

  let successCount = 0;
  let errorCount = 0;

  for (const integration of integrations) {
    const entity = {
      partitionKey: integration.type, // Usar tipo como PartitionKey para agruparlas
      rowKey: integration.id, // Usar el ID fijo o generado
      // Incluir todos los campos definidos en la interfaz IntegrationCatalogItem
      name: integration.name,
      description: integration.description,
      type: integration.type,
      provider: integration.provider,
      icon: integration.icon,
      // Serializar los campos que son objetos/arrays a string JSON
      capabilityTools: JSON.stringify(integration.capabilityTools),
      requiresAuth: integration.requiresAuth,
      setupGuide: integration.setupGuide,
      configSchema: JSON.stringify(integration.configSchema) // Serializar incluso si está vacío
    };

    try {
      // Usar upsertEntity con modo Replace para asegurar que siempre se actualice
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

// --- Lógica para ejecutar desde línea de comandos ---
// Verifica si el script se ejecuta directamente
if (require.main === module) {
  initializeCatalog().catch(error => {
    console.error("Falló la inicialización del catálogo de integraciones:", error);
    process.exit(1);
  });
} else {
   // Si se importa como módulo, exportar la función podría ser útil
   // module.exports = initializeCatalog;
   console.log("Script initializeCatalog cargado como módulo.");
}