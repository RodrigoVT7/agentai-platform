// Script para inicializar el catálogo de integraciones
import { TableClient } from "@azure/data-tables";
import { IntegrationType } from "../shared/models/integration.model";
import { v4 as uuidv4 } from "uuid";

const connectionString = process.env.STORAGE_CONNECTION_STRING ?? "";
const TABLE_NAME = "integrationcatalog"; // Debe coincidir con STORAGE_TABLES.INTEGRATION_CATALOG

async function initializeCatalog() {
  // Validar variables de entorno
//   if (!connectionString) {
//     console.error("Error: Variable de entorno connectionString es requerida.");
//     return;
//   }

  console.log("Inicializando catálogo de integraciones...");

  // Crear cliente de tabla
  const tableClient = TableClient.fromConnectionString(process.env.AzureWebJobsStorage ?? "" ,
    TABLE_NAME
  );

  // Crear tabla si no existe
  try {
    await tableClient.createTable();
    console.log(`Tabla ${TABLE_NAME} creada.`);
  } catch (error: any) {
    if (error.code === "TableAlreadyExists") {
      console.log(`Tabla ${TABLE_NAME} ya existe.`);
    } else {
      console.error("Error al crear tabla:", error);
      return;
    }
  }

  // Definir integraciones a crear
  const integrations = [
    // WhatsApp
    {
      id: uuidv4(),
      name: "WhatsApp",
      description: "Integración con WhatsApp Business API para enviar y recibir mensajes.",
      type: IntegrationType.MESSAGING,
      provider: "whatsapp",
      icon: "https://example.com/icons/whatsapp.png",
      capabilities: ["sendMessage", "sendTemplate"],
      requiresAuth: true,
      setupGuide: "Para configurar WhatsApp, necesitas una cuenta Business, un número aprobado y acceso a la API.",
      configSchema: {
        properties: {
          phoneNumberId: { type: "string", title: "ID del número de teléfono" },
          businessAccountId: { type: "string", title: "ID de la cuenta de negocio" },
          accessToken: { type: "string", title: "Token de acceso", format: "password" },
          webhookVerifyToken: { type: "string", title: "Token de verificación del webhook" },
          phoneNumber: { type: "string", title: "Número de teléfono (con formato internacional)" },
          displayName: { type: "string", title: "Nombre a mostrar" }
        },
        required: ["phoneNumberId", "businessAccountId", "accessToken", "phoneNumber"]
      }
    },
    
    // Google Calendar
    {
      id: uuidv4(),
      name: "Google Calendar",
      description: "Integración con Google Calendar para gestionar eventos y calendarios.",
      type: IntegrationType.CALENDAR,
      provider: "google",
      icon: "https://example.com/icons/google-calendar.png",
      capabilities: ["getEvents", "createEvent", "updateEvent", "deleteEvent"],
      requiresAuth: true,
      setupGuide: "La integración con Google Calendar requiere autenticación OAuth.",
      configSchema: {
        properties: {
          calendarId: { type: "string", title: "ID del calendario (usar 'primary' para el principal)" }
        }
      }
    },
    
    // Microsoft 365 Calendar
    {
      id: uuidv4(),
      name: "Microsoft 365 Calendar",
      description: "Integración con Microsoft Outlook Calendar para gestionar eventos y calendarios.",
      type: IntegrationType.CALENDAR,
      provider: "microsoft",
      icon: "https://example.com/icons/microsoft-calendar.png",
      capabilities: ["getEvents", "createEvent", "updateEvent", "deleteEvent"],
      requiresAuth: true,
      setupGuide: "La integración con Microsoft Calendar requiere autenticación OAuth.",
      configSchema: {
        properties: {
          calendarId: { type: "string", title: "ID del calendario (usar 'primary' para el principal)" }
        }
      }
    },
    
    // Microsoft 365 Email
    {
      id: uuidv4(),
      name: "Microsoft 365 Email",
      description: "Integración con Microsoft Outlook Email para enviar y recibir correos.",
      type: IntegrationType.EMAIL,
      provider: "microsoft",
      icon: "https://example.com/icons/microsoft-email.png",
      capabilities: ["sendEmail", "getEmails"],
      requiresAuth: true,
      setupGuide: "La integración con Microsoft Email requiere autenticación OAuth.",
      configSchema: {
        properties: {
          mailbox: { type: "string", title: "Dirección de correo principal" }
        }
      }
    },
    
    // SAP ERP
    {
      id: uuidv4(),
      name: "SAP ERP",
      description: "Integración con sistemas SAP ERP para acceder a datos corporativos.",
      type: IntegrationType.ERP,
      provider: "sap",
      icon: "https://example.com/icons/sap.png",
      capabilities: ["queryData", "createRecord", "updateRecord", "deleteRecord"],
      requiresAuth: true,
      setupGuide: "La integración con SAP requiere configuración específica y credenciales.",
      configSchema: {
        properties: {
          url: { type: "string", title: "URL del servidor SAP" },
          username: { type: "string", title: "Usuario" },
          password: { type: "string", title: "Contraseña", format: "password" },
          clientId: { type: "string", title: "ID de cliente" },
          systemId: { type: "string", title: "ID del sistema" }
        },
        required: ["url", "username", "password", "clientId"]
      }
    },
    
    // Microsoft Dynamics
    {
      id: uuidv4(),
      name: "Microsoft Dynamics",
      description: "Integración con Microsoft Dynamics 365 para CRM y ERP.",
      type: IntegrationType.ERP,
      provider: "dynamics",
      icon: "https://example.com/icons/dynamics.png",
      capabilities: ["queryData", "createRecord", "updateRecord", "deleteRecord"],
      requiresAuth: true,
      setupGuide: "La integración con Dynamics requiere configuración de la API y autenticación.",
      configSchema: {
        properties: {
          url: { type: "string", title: "URL de la instancia de Dynamics" },
          tenantId: { type: "string", title: "ID del inquilino" },
          clientId: { type: "string", title: "ID de cliente" },
          clientSecret: { type: "string", title: "Secreto del cliente", format: "password" }
        },
        required: ["url", "tenantId", "clientId", "clientSecret"]
      }
    },
    
    // Odoo ERP
    {
      id: uuidv4(),
      name: "Odoo ERP",
      description: "Integración con Odoo ERP para gestión empresarial.",
      type: IntegrationType.ERP,
      provider: "odoo",
      icon: "https://example.com/icons/odoo.png",
      capabilities: ["queryData", "createRecord", "updateRecord", "deleteRecord"],
      requiresAuth: true,
      setupGuide: "La integración con Odoo requiere acceso a la API XML-RPC.",
      configSchema: {
        properties: {
          url: { type: "string", title: "URL del servidor Odoo" },
          database: { type: "string", title: "Nombre de la base de datos" },
          username: { type: "string", title: "Usuario" },
          password: { type: "string", title: "Contraseña", format: "password" }
        },
        required: ["url", "database", "username", "password"]
      }
    },
    
    // ERP Genérico
    {
      id: uuidv4(),
      name: "ERP Genérico",
      description: "Integración con sistemas ERP personalizados a través de API REST.",
      type: IntegrationType.ERP,
      provider: "generic",
      icon: "https://example.com/icons/generic-erp.png",
      capabilities: ["queryData", "createRecord", "updateRecord", "deleteRecord"],
      requiresAuth: true,
      setupGuide: "La integración con ERP genérico requiere una API REST y credenciales de acceso.",
      configSchema: {
        properties: {
          url: { type: "string", title: "URL base de la API" },
          apiKey: { type: "string", title: "Clave de API", format: "password" },
          username: { type: "string", title: "Usuario (alternativa a API Key)" },
          password: { type: "string", title: "Contraseña (alternativa a API Key)", format: "password" }
        },
        required: ["url"]
      }
    }
  ];

  // Insertar registros en la tabla
  console.log(`Iniciando inserción de ${integrations.length} integraciones...`);
  
  for (const integration of integrations) {
    const entity = {
      partitionKey: integration.type,
      rowKey: integration.id,
      ...integration,
      // Serializar campos complejos
      capabilities: JSON.stringify(integration.capabilities),
      configSchema: JSON.stringify(integration.configSchema)
    };

    try {
      await tableClient.createEntity(entity);
      console.log(`✓ Integración ${integration.name} (${integration.provider}) creada.`);
    } catch (error: any) {
      if (error.code === "EntityAlreadyExists") {
        console.log(`! Integración ${integration.name} ya existe. Actualizando...`);
        await tableClient.updateEntity(entity, "Replace");
        console.log(`✓ Integración ${integration.name} actualizada.`);
      } else {
        console.error(`✗ Error al crear integración ${integration.name}:`, error);
      }
    }
  }

  console.log("Inicialización del catálogo completada.");
}

// Ejecutar la función principal
initializeCatalog().catch(error => {
  console.error("Error en la inicialización:", error);
});