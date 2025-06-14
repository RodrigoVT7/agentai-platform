// src/functions/agents/AgentBusinessRules.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { UniversalValidationEngine, AgentBusinessRules } from "../../shared/services/universalValidationEngine";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";
import { JwtService } from "../../shared/utils/jwt.service";
import { StorageService } from "../../shared/services/storage.service";
import { STORAGE_TABLES } from "../../shared/constants";

export async function AgentBusinessRulesAPI(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const logger = createLogger(context);
  
  try {
    // Verificar autenticación
    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return {
        status: 401,
        jsonBody: { error: "Se requiere autenticación" }
      };
    }
    
    const token = authHeader.split(' ')[1];
    const jwtService = new JwtService();
    
    let payload;
    try {
      payload = jwtService.verifyToken(token);
    } catch (error) {
      return {
        status: 401,
        jsonBody: { error: "Token inválido o expirado" }
      };
    }
    
    const userId = payload.userId;
    if (!userId) {
      return {
        status: 401,
        jsonBody: { error: "Token no contiene userId" }
      };
    }
    
    const agentId = request.params.agentId;
    if (!agentId) {
      return {
        status: 400,
        jsonBody: { error: "Se requiere ID del agente" }
      };
    }
    
    // Verificar acceso al agente
    const hasAccess = await verifyAgentAccess(agentId, userId);
    if (!hasAccess) {
      return {
        status: 403,
        jsonBody: { error: "No tienes permiso para acceder a este agente" }
      };
    }
    
    const validationEngine = new UniversalValidationEngine(logger);
    
    switch (request.method) {
      case 'GET':
        return await handleGetRules(agentId, validationEngine);
        
      case 'PUT':
        const updateData = await request.json() as { businessRules: AgentBusinessRules };
        return await handleUpdateRules(agentId, updateData, validationEngine, logger);
        
      case 'POST':
        const action = request.query.get('action');
        if (action === 'validate') {
          const validationData = await request.json() as { action: string, parameters: any };
          return await handleValidateAction(agentId, validationData, validationEngine);
        } else if (action === 'preset') {
          const presetData = await request.json() as { businessType: string, customizations?: Partial<AgentBusinessRules> };
          return await handleApplyPreset(agentId, presetData, validationEngine, logger);
        }
        break;
        
      case 'DELETE':
        return await handleResetRules(agentId, validationEngine, logger);
    }
    
    return {
      status: 405,
      jsonBody: { error: "Método no permitido" }
    };
    
  } catch (error) {
    logger.error("Error en AgentBusinessRulesAPI:", error);
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

async function handleGetRules(agentId: string, validationEngine: UniversalValidationEngine): Promise<HttpResponseInit> {
  try {
    // Obtener reglas actuales del agente
    const storageService = new StorageService();
    const tableClient = storageService.getTableClient(STORAGE_TABLES.AGENTS);
    const agent = await tableClient.getEntity('agent', agentId);
    
    let currentRules: AgentBusinessRules = {};
    if (agent.businessRules) {
      if (typeof agent.businessRules === 'string') {
        try {
          currentRules = JSON.parse(agent.businessRules);
        } catch (e) {
          currentRules = {};
        }
      } else if (typeof agent.businessRules === 'object') {
        currentRules = agent.businessRules as AgentBusinessRules;
      }
    }
    
    return {
      status: 200,
      jsonBody: {
        agentId,
        agentName: agent.name,
        businessRules: currentRules,
        lastUpdated: agent.updatedAt || agent.createdAt
      }
    };
  } catch (error) {
    return {
      status: 404,
      jsonBody: { error: "Agente no encontrado" }
    };
  }
}

async function handleUpdateRules(
  agentId: string, 
  updateData: { businessRules: AgentBusinessRules }, 
  validationEngine: UniversalValidationEngine,
  logger: any
): Promise<HttpResponseInit> {
  try {
    // Validar estructura de reglas
    const validationResult = validateBusinessRulesStructure(updateData.businessRules);
    if (!validationResult.valid) {
      return {
        status: 400,
        jsonBody: { 
          error: "Estructura de reglas inválida", 
          details: validationResult.errors 
        }
      };
    }
    
    // Actualizar reglas
    await validationEngine.updateAgentBusinessRules(agentId, updateData.businessRules);
    
    logger.info(`✅ Reglas de negocio actualizadas para agente ${agentId}`);
    
    return {
      status: 200,
      jsonBody: {
        success: true,
        message: "Reglas de negocio actualizadas exitosamente",
        agentId,
        appliedRules: updateData.businessRules
      }
    };
  } catch (error) {
    return {
      status: 500,
      jsonBody: { error: "Error actualizando reglas de negocio" }
    };
  }
}

async function handleValidateAction(
  agentId: string, 
  validationData: { action: string, parameters: any }, 
  validationEngine: UniversalValidationEngine
): Promise<HttpResponseInit> {
  try {
    const { action, parameters } = validationData;
    
    const result = await validationEngine.validateAction(agentId, action, parameters);
    
    return {
      status: 200,
      jsonBody: {
        valid: result.valid,
        error: result.error,
        suggestion: result.suggestion,
        correctedParameters: result.correctedParameters
      }
    };
  } catch (error) {
    return {
      status: 500,
      jsonBody: { error: "Error en validación" }
    };
  }
}

async function handleApplyPreset(
  agentId: string, 
  presetData: { businessType: string, customizations?: Partial<AgentBusinessRules> }, 
  validationEngine: UniversalValidationEngine,
  logger: any
): Promise<HttpResponseInit> {
  try {
    const { businessType, customizations } = presetData;
    
    // Obtener reglas predefinidas
    let presetRules: AgentBusinessRules;
    
    switch (businessType) {
      case 'real_estate':
        presetRules = {
          calendar: {
            enabled: true,
            workingDays: [1, 2, 3, 4, 5, 6], // Lun-Sáb
            workingHours: { start: 9, end: 18 },
            minAdvanceHours: 24,
            maxAdvanceWeeks: 4,
            timeZone: 'America/Mexico_City',
            allowSameDayBooking: false
          },
          messaging: {
            enabled: true,
            maxMessageLength: 1000,
            allowedTypes: ['text', 'image', 'document']
          },
          dateValidation: {
            enabled: true,
            strictMode: true
          }
        };
        break;
        
      case 'medical':
        presetRules = {
          calendar: {
            enabled: true,
            workingDays: [1, 2, 3, 4, 5],
            workingHours: { start: 8, end: 17 },
            minAdvanceHours: 48,
            maxAdvanceWeeks: 12,
            timeZone: 'America/Mexico_City',
            allowSameDayBooking: false,
            breakTimes: [{ start: 13, end: 14 }]
          },
          messaging: {
            enabled: true,
            maxMessageLength: 500,
            allowedTypes: ['text']
          },
          dateValidation: {
            enabled: true,
            strictMode: true
          }
        };
        break;
        
      case 'finance':
        presetRules = {
          calendar: {
            enabled: true,
            workingDays: [1, 2, 3, 4, 5],
            workingHours: { start: 9, end: 17 },
            minAdvanceHours: 4,
            maxAdvanceWeeks: 8,
            timeZone: 'America/Mexico_City',
            allowSameDayBooking: true,
            maxConcurrentAppointments: 3
          },
          messaging: {
            enabled: true,
            maxMessageLength: 2000,
            allowedTypes: ['text', 'document', 'image']
          },
          dateValidation: {
            enabled: true,
            strictMode: false
          }
        };
        break;
        
      default:
        return {
          status: 400,
          jsonBody: { 
            error: "Tipo de negocio no soportado",
            supportedTypes: ['real_estate', 'medical', 'finance']
          }
        };
    }
    
    // Aplicar personalizaciones si existen
    if (customizations) {
      presetRules = deepMerge(presetRules, customizations);
    }
    
    // Actualizar reglas
    await validationEngine.updateAgentBusinessRules(agentId, presetRules);
    
    logger.info(`✅ Preset "${businessType}" aplicado al agente ${agentId}`);
    
    return {
      status: 200,
      jsonBody: {
        success: true,
        message: `Configuración predefinida "${businessType}" aplicada exitosamente`,
        appliedRules: presetRules,
        businessType
      }
    };
  } catch (error) {
    return {
      status: 500,
      jsonBody: { error: "Error aplicando configuración predefinida" }
    };
  }
}

async function handleResetRules(
  agentId: string, 
  validationEngine: UniversalValidationEngine,
  logger: any
): Promise<HttpResponseInit> {
  try {
    const defaultRules: AgentBusinessRules = {
      calendar: {
        enabled: true,
        workingDays: [1, 2, 3, 4, 5],
        workingHours: { start: 9, end: 18 },
        minAdvanceHours: 24,
        maxAdvanceWeeks: 8,
        timeZone: 'America/Mexico_City',
        allowSameDayBooking: false
      },
      messaging: {
        enabled: true,
        maxMessageLength: 1000,
        allowedTypes: ['text', 'image']
      },
      dateValidation: {
        enabled: true,
        strictMode: false
      }
    };
    
    await validationEngine.updateAgentBusinessRules(agentId, defaultRules);
    
    logger.info(`🔄 Reglas reseteadas a valores por defecto para agente ${agentId}`);
    
    return {
      status: 200,
      jsonBody: {
        success: true,
        message: "Reglas reseteadas a valores por defecto",
        defaultRules
      }
    };
  } catch (error) {
    return {
      status: 500,
      jsonBody: { error: "Error reseteando reglas" }
    };
  }
}

// Función auxiliar para verificar acceso al agente
async function verifyAgentAccess(agentId: string, userId: string): Promise<boolean> {
  try {
    const storageService = new StorageService();
    
    // Verificar si es propietario
    const agentsTable = storageService.getTableClient(STORAGE_TABLES.AGENTS);
    try {
      const agent = await agentsTable.getEntity('agent', agentId);
      if (agent.userId === userId) {
        return true;
      }
    } catch (error) {
      return false;
    }
    
    // Verificar roles
    const rolesTable = storageService.getTableClient(STORAGE_TABLES.USER_ROLES);
    const roles = rolesTable.listEntities({
      queryOptions: { filter: `agentId eq '${agentId}' and userId eq '${userId}' and isActive eq true` }
    });
    
    for await (const role of roles) {
      return true;
    }
    
    return false;
  } catch (error) {
    return false;
  }
}

// Función para validar estructura de reglas de negocio
function validateBusinessRulesStructure(rules: AgentBusinessRules): { valid: boolean, errors?: string[] } {
  const errors: string[] = [];
  
  // Validar reglas de calendario
  if (rules.calendar) {
    if (rules.calendar.workingDays && !Array.isArray(rules.calendar.workingDays)) {
      errors.push("workingDays debe ser un array");
    }
    
    if (rules.calendar.workingDays) {
      const invalidDays = rules.calendar.workingDays.filter(day => day < 0 || day > 6);
      if (invalidDays.length > 0) {
        errors.push("workingDays debe contener números entre 0-6 (0=domingo, 6=sábado)");
      }
    }
    
    if (rules.calendar.workingHours) {
      if (typeof rules.calendar.workingHours.start !== 'number' || 
          typeof rules.calendar.workingHours.end !== 'number') {
        errors.push("workingHours.start y workingHours.end deben ser números");
      }
      
      if (rules.calendar.workingHours.start >= rules.calendar.workingHours.end) {
        errors.push("workingHours.start debe ser menor que workingHours.end");
      }
      
      if (rules.calendar.workingHours.start < 0 || rules.calendar.workingHours.start > 23 ||
          rules.calendar.workingHours.end < 0 || rules.calendar.workingHours.end > 24) {
        errors.push("workingHours debe estar entre 0-23 para start y 0-24 para end");
      }
    }
    
    if (rules.calendar.minAdvanceHours !== undefined && 
        (typeof rules.calendar.minAdvanceHours !== 'number' || rules.calendar.minAdvanceHours < 0)) {
      errors.push("minAdvanceHours debe ser un número positivo");
    }
  }
  
  // Validar reglas de mensajería
  if (rules.messaging) {
    if (rules.messaging.maxMessageLength !== undefined && 
        (typeof rules.messaging.maxMessageLength !== 'number' || rules.messaging.maxMessageLength <= 0)) {
      errors.push("maxMessageLength debe ser un número positivo");
    }
    
    if (rules.messaging.allowedTypes && !Array.isArray(rules.messaging.allowedTypes)) {
      errors.push("allowedTypes debe ser un array");
    }
  }
  
  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined
  };
}

// Función auxiliar para merge profundo de objetos
function deepMerge(target: any, source: any): any {
  const result = { ...target };
  
  for (const key in source) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  
  return result;
}

// Registrar las rutas
app.http('AgentBusinessRulesGet', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'agents/{agentId}/business-rules',
  handler: AgentBusinessRulesAPI
});

app.http('AgentBusinessRulesUpdate', {
  methods: ['PUT'],
  authLevel: 'anonymous', 
  route: 'agents/{agentId}/business-rules',
  handler: AgentBusinessRulesAPI
});

app.http('AgentBusinessRulesActions', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'agents/{agentId}/business-rules',
  handler: AgentBusinessRulesAPI
});

app.http('AgentBusinessRulesReset', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'agents/{agentId}/business-rules', 
  handler: AgentBusinessRulesAPI
});