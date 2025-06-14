// src/shared/services/universalValidationEngine.ts

import { StorageService } from "./storage.service";
import { STORAGE_TABLES } from "../constants";
import { Logger, createLogger } from "../utils/logger";

export interface ValidationResult {
  valid: boolean;
  error?: string;
  suggestion?: string;
  correctedParameters?: any;
}

export interface CalendarRules {
  enabled?: boolean;
  workingDays?: number[]; // [1,2,3,4,5] = lunes-viernes (0=domingo, 6=sábado)
  workingHours?: { start: number, end: number }; // { start: 9, end: 18 }
  minAdvanceHours?: number; // 24
  maxAdvanceWeeks?: number; // 8 (no más de 8 semanas adelante)
  timeZone?: string; // "America/Mexico_City"
  maxConcurrentAppointments?: number;
  allowSameDayBooking?: boolean;
  breakTimes?: Array<{ start: number, end: number }>; // Horarios de descanso
  
  // 🔥 NUEVAS PROPIEDADES:
  holidayCalendar?: string[]; // Array de fechas en formato YYYY-MM-DD
  maxAppointmentDurationHours?: number; // Duración máxima de una cita
  timeSlotIntervalMinutes?: number; // Intervalos de tiempo permitidos (15, 30, 60 minutos)
  bufferTimeMinutes?: number; // Tiempo de buffer entre citas
  earlyBookingLimitDays?: number; // Límite de anticipación en días
}

export interface MessagingRules {
  enabled?: boolean;
  maxMessageLength?: number;
  allowedTypes?: string[]; // ['text', 'image', 'document']
  rateLimitMinutes?: number; // Minutos entre mensajes del mismo usuario
  bannedWords?: string[];
}

export interface AgentBusinessRules {
  calendar?: CalendarRules;
  messaging?: MessagingRules;
  dateValidation?: {
    enabled: boolean;
    strictMode?: boolean; // Modo estricto: rechaza ambigüedades
    customRules?: string[]; // Reglas específicas del cliente
  };
  general?: {
    allowWeekends?: boolean;
    businessTimeZone?: string;
    holidayCalendar?: string[]; // Fechas de días festivos
  };
}

export class UniversalValidationEngine {
  private storageService: StorageService;
  private logger: Logger;
  private agentRulesCache: Map<string, AgentBusinessRules> = new Map();
  private cacheExpiry: Map<string, number> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutos

  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }

  /**
   * Punto de entrada principal para validar cualquier acción
   */
  async validateAction(
    agentId: string,
    action: string,
    parameters: any,
    context?: any
  ): Promise<ValidationResult> {
    try {
      const agentRules = await this.getAgentBusinessRules(agentId);
      
      this.logger.info(`🔍 [Validation] Validando acción '${action}' para agente ${agentId}`);
      
      switch (action) {
        case 'createEvent':
        case 'updateEvent':
          return await this.validateCalendarAction(parameters, agentRules.calendar, context);
        
        case 'sendMessage':
        case 'sendTemplate':
          return this.validateMessagingAction(parameters, agentRules.messaging);
        
        case 'deleteEvent':
          return this.validateDeleteAction(parameters, agentRules.calendar);
        
        default:
          // Para acciones no específicas, validación general
          return this.validateGeneralAction(parameters, agentRules.general);
      }
    } catch (error) {
      this.logger.error(`Error en validación para agente ${agentId}:`, error);
      return {
        valid: false,
        error: "Error interno de validación"
      };
    }
  }

  /**
   * Validación específica para acciones de calendario
   */
private async validateCalendarAction(
    params: any,
    rules?: CalendarRules,
    context?: any
  ): Promise<ValidationResult> {
    
    if (!rules?.enabled) {
      return { valid: true };
    }

    // 1. VALIDACIÓN DE EVENTID (para update/delete)
    if ((params.action === 'updateEvent' || params.action === 'deleteEvent') && params.eventId) {
      const eventIdValidation = await this.validateAndCorrectEventId(
        params.eventId, 
        params.integrationId, 
        context?.userId,
        context
      );
      
      if (!eventIdValidation.valid) {
        return eventIdValidation;
      }
      
      // Si se corrigió el ID, actualizar parámetros
      if (eventIdValidation.correctedParameters?.eventId) {
        params.eventId = eventIdValidation.correctedParameters.eventId;
      }
    }

    // 2. VALIDACIÓN DE REGLAS DE NEGOCIO (fechas, horarios, etc.)
    const businessRulesValidation = await this.validateBusinessRules(params, rules, context);
    if (!businessRulesValidation.valid) {
      return businessRulesValidation;
    }

    return { valid: true };
  }


  /**
   * NUEVO: Validación y corrección automática de EventId
   */
  private async validateAndCorrectEventId(
    eventId: string,
    integrationId: string,
    userId: string,
    context?: any
  ): Promise<ValidationResult> {
    
    // Lista expandida de IDs ficticios
    const fakeEventIds = [
      'existing-event-id', 'event-id', 'sample-event-id', 'placeholder-id',
      'dummy-id', 'test-id', 'martes-10-junio-10am', 'lunes-9-junio-5pm',
      'cita-usuario', 'appointment-id', 'event-to-update', 'current-event',
      'user-appointment'
    ];
    
    // Criterios para detectar IDs ficticios
    const isFakeId = !eventId || 
      fakeEventIds.includes(eventId) ||
      eventId.length < 15 ||
      eventId.includes('-') && eventId.split('-').length > 2 ||
      !/^[a-z0-9]+$/i.test(eventId) ||
      /^\d{1,2}-\d{1,2}/.test(eventId);

    if (isFakeId) {
      this.logger.warn(`🚫 [EventId Validation] ID ficticio detectado: "${eventId}"`);
      
      try {
        const realEventId = await this.findRealEventId(integrationId, userId, eventId, context);
        
        if (realEventId) {
          this.logger.info(`✅ [EventId Validation] Auto-corrección exitosa: ${eventId} → ${realEventId}`);
          return {
            valid: true,
            correctedParameters: { eventId: realEventId }
          };
        } else {
          return {
            valid: false,
            error: `ID de evento ficticio detectado ("${eventId}"). No se encontraron citas para modificar.`,
            suggestion: "Usa getMyBookedCalendarEvents para obtener las citas reales del usuario"
          };
        }
      } catch (error) {
        return {
          valid: false,
          error: `Error al corregir ID ficticio: ${error instanceof Error ? error.message : String(error)}`
        };
      }
    }

    // Si el ID parece real, verificar que existe
    try {
      const exists = await this.verifyEventExists(integrationId, eventId, userId, context);
      if (!exists) {
        // Intentar auto-corrección incluso para IDs que parecen reales
        const realEventId = await this.findRealEventId(integrationId, userId, eventId, context);
        if (realEventId) {
          this.logger.info(`✅ [EventId Validation] ID inexistente corregido: ${eventId} → ${realEventId}`);
          return {
            valid: true,
            correctedParameters: { eventId: realEventId }
          };
        }
        
        return {
          valid: false,
          error: `El evento con ID ${eventId} no existe o no pertenece al usuario`,
          suggestion: "Verifica que el ID del evento sea correcto"
        };
      }
    } catch (error) {
      this.logger.warn(`⚠️ [EventId Validation] No se pudo verificar existencia de ${eventId}:`, error);
    }

    return { valid: true };
  }

  /**
   * NUEVO: Buscar ID real de evento para el usuario
   */
  private async findRealEventId(
    integrationId: string,
    userId: string,
    fakeEventId?: string,
    context?: any
  ): Promise<string | null> {
    
    try {
      // Necesitamos acceso al GoogleCalendarHandler
      // Por ahora, usamos el contexto para acceder
      if (!context?.googleCalendarHandler) {
        this.logger.error('❌ [EventId Validation] GoogleCalendarHandler no disponible en contexto');
        return null;
      }

      const response = await context.googleCalendarHandler.getMyBookedEvents(integrationId, userId, {
        startDate: new Date().toISOString(),
        endDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
      });

      if (response.status === 200 && response.jsonBody?.success) {
        const futureEvents = response.jsonBody.result.events?.filter((event: any) => {
          const eventEndTime = event.end?.dateTime || event.end?.date;
          return eventEndTime && (new Date(eventEndTime) > new Date());
        }) || [];

        this.logger.info(`📊 [EventId Validation] Encontrados ${futureEvents.length} eventos futuros`);

        if (futureEvents.length === 1) {
          return futureEvents[0].id;
        } else if (futureEvents.length > 1) {
          // Aplicar heurística inteligente
          const bestMatch = this.findBestEventMatch(futureEvents, fakeEventId);
          if (bestMatch) {
            return bestMatch.id;
          }
          
          // Fallback: evento más próximo
          const sortedByDate = futureEvents.sort((a: any, b: any) => {
            const dateA = new Date(a.start?.dateTime || a.start?.date);
            const dateB = new Date(b.start?.dateTime || b.start?.date);
            return dateA.getTime() - dateB.getTime();
          });
          
          this.logger.warn(`⚠️ [EventId Validation] Múltiples citas, usando la más próxima`);
          return sortedByDate[0].id;
        }
      }

      return null;
    } catch (error) {
      this.logger.error('❌ [EventId Validation] Error buscando evento real:', error);
      return null;
    }
  }

  /**
   * NUEVO: Heurística para encontrar mejor coincidencia
   */
  private findBestEventMatch(events: any[], fakeEventId?: string): any | null {
    if (!fakeEventId || events.length === 0) return null;
    
    const lowerFakeId = fakeEventId.toLowerCase();
    
    for (const event of events) {
      const startTime = event.start?.dateTime || event.start?.date;
      
      // Coincidencia por día de semana
      if (lowerFakeId.includes('lunes') || lowerFakeId.includes('martes') || 
          lowerFakeId.includes('miercoles') || lowerFakeId.includes('jueves') || 
          lowerFakeId.includes('viernes')) {
        
        const eventDate = new Date(startTime);
        const dayNames = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
        const eventDayName = dayNames[eventDate.getDay()];
        
        if (lowerFakeId.includes(eventDayName)) {
          this.logger.info(`🎯 [EventId Validation] Coincidencia por día: ${eventDayName}`);
          return event;
        }
      }
      
      // Coincidencia por hora
      if (lowerFakeId.includes('10am') || lowerFakeId.includes('5pm')) {
        const eventHour = new Date(startTime).getHours();
        const fakeHour = lowerFakeId.includes('10am') ? 10 : 17;
        
        if (Math.abs(eventHour - fakeHour) <= 1) {
          this.logger.info(`🎯 [EventId Validation] Coincidencia por hora: ${eventHour}h ≈ ${fakeHour}h`);
          return event;
        }
      }
    }
    
    return null;
  }

  /**
   * NUEVO: Verificar que un evento existe
   */
  private async verifyEventExists(
    integrationId: string,
    eventId: string,
    userId: string,
    context?: any
  ): Promise<boolean> {
    
    try {
      if (!context?.googleCalendarHandler) {
        return false;
      }

      const response = await context.googleCalendarHandler.getMyBookedEvents(integrationId, userId, {
        startDate: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
        endDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
      });

      if (response.status === 200 && response.jsonBody?.success) {
        const events = response.jsonBody.result.events || [];
        return events.some((event: any) => event.id === eventId);
      }

      return false;
    } catch (error) {
      this.logger.error(`❌ [EventId Validation] Error verificando evento ${eventId}:`, error);
      throw error;
    }
  }

 /**
 * NUEVO: Validar solo reglas de negocio (separado de eventId)
 */
private async validateBusinessRules(
  params: any,
  rules?: CalendarRules,
  context?: any
): Promise<ValidationResult> {
  
  const timeZone = rules?.timeZone || 'UTC';
  
  // Validar que existan fechas
  if (!params.start || (!params.start.dateTime && !params.start.date)) {
    return {
      valid: false,
      error: "Fecha de inicio requerida",
      suggestion: "Especifica una fecha y hora válida"
    };
  }

  try {
    const startDate = new Date(params.start.dateTime || params.start.date);
    const now = new Date();
    
    if (isNaN(startDate.getTime())) {
      return {
        valid: false,
        error: "Formato de fecha inválido",
        suggestion: "Usa formato ISO: YYYY-MM-DDTHH:MM:SS"
      };
    }

    // 1. VALIDAR ANTICIPACIÓN MÍNIMA
    if (rules?.minAdvanceHours) {
      const hoursDiff = (startDate.getTime() - now.getTime()) / (1000 * 60 * 60);
      if (hoursDiff < rules.minAdvanceHours) {
        const minDate = new Date(now.getTime() + rules.minAdvanceHours * 60 * 60 * 1000);
        return {
          valid: false,
          error: `Se requieren al menos ${rules.minAdvanceHours} horas de anticipación`,
          suggestion: `La fecha más temprana disponible es: ${minDate.toLocaleDateString('es-MX', {
            weekday: 'long',
            year: 'numeric',
            month: 'long', 
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            timeZone: timeZone
          })}`
        };
      }
    }

    // 2. VALIDAR ANTICIPACIÓN MÁXIMA
    if (rules?.maxAdvanceWeeks) {
      const weeksDiff = (startDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24 * 7);
      if (weeksDiff > rules.maxAdvanceWeeks) {
        const maxDate = new Date(now.getTime() + rules.maxAdvanceWeeks * 7 * 24 * 60 * 60 * 1000);
        return {
          valid: false,
          error: `No se pueden agendar citas con más de ${rules.maxAdvanceWeeks} semanas de anticipación`,
          suggestion: `Fecha límite: ${maxDate.toLocaleDateString('es-MX', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            timeZone: timeZone
          })}`
        };
      }
    }

    // 3. VALIDAR DÍAS LABORALES
    if (rules?.workingDays && rules.workingDays.length > 0) {
      const dayOfWeek = startDate.getDay();
      if (!rules.workingDays.includes(dayOfWeek)) {
        const dayNames = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
        const allowedDays = rules.workingDays.map(d => dayNames[d]).join(', ');
        
        return {
          valid: false,
          error: "Día no disponible para citas",
          suggestion: `Días disponibles: ${allowedDays}`
        };
      }
    }

    // 4. VALIDAR HORARIOS LABORALES (solo para eventos con hora específica)
    if (rules?.workingHours && params.start.dateTime) {
      const hour = startDate.getHours();
      const minute = startDate.getMinutes();
      const { start: startHour, end: endHour } = rules.workingHours;
      
      if (hour < startHour || hour >= endHour) {
        const startTime = this.formatHour(startHour);
        const endTime = this.formatHour(endHour);
        
        return {
          valid: false,
          error: `Horario fuera del rango permitido`,
          suggestion: `Horario disponible: ${startTime} - ${endTime}`
        };
      }
      
      // Validar que no sea exactamente en la hora de cierre
      if (hour === endHour - 1 && minute > 0) {
        const endTime = this.formatHour(endHour);
        return {
          valid: false,
          error: `Horario muy cercano al cierre`,
          suggestion: `Última cita disponible: ${this.formatHour(endHour - 1)}:00. Horario de cierre: ${endTime}`
        };
      }
    }

    // 5. VALIDAR HORARIOS DE DESCANSO
    if (rules?.breakTimes && params.start.dateTime) {
      const hour = startDate.getHours();
      const minute = startDate.getMinutes();
      const totalMinutes = hour * 60 + minute;
      
      for (const breakTime of rules.breakTimes) {
        const breakStart = breakTime.start * 60;
        const breakEnd = breakTime.end * 60;
        
        if (totalMinutes >= breakStart && totalMinutes < breakEnd) {
          const breakStartFormatted = this.formatDecimalHour(breakTime.start);
          const breakEndFormatted = this.formatDecimalHour(breakTime.end);
          
          return {
            valid: false,
            error: "Horario en periodo de descanso",
            suggestion: `Evita el horario de ${breakStartFormatted} - ${breakEndFormatted}`
          };
        }
      }
    }

    // 6. VALIDAR RESERVAS DEL MISMO DÍA
    if (!rules?.allowSameDayBooking) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const appointmentDay = new Date(startDate);
      appointmentDay.setHours(0, 0, 0, 0);
      
      if (appointmentDay.getTime() === today.getTime()) {
        const tomorrow = new Date(today);
        tomorrow.setDate(today.getDate() + 1);
        
        return {
          valid: false,
          error: "No se permiten citas para el mismo día",
          suggestion: `Selecciona una fecha a partir de: ${tomorrow.toLocaleDateString('es-MX', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric',
            timeZone: timeZone
          })}`
        };
      }
    }

    // 7. VALIDAR DÍAS FESTIVOS (si están configurados)
    if (rules?.holidayCalendar && rules.holidayCalendar.length > 0) {
      const appointmentDateStr = startDate.toISOString().split('T')[0]; // YYYY-MM-DD
      if (rules.holidayCalendar.includes(appointmentDateStr)) {
        return {
          valid: false,
          error: "Fecha no disponible (día festivo)",
          suggestion: "Selecciona una fecha que no sea día festivo"
        };
      }
    }

    // 8. VALIDAR FECHA NO SEA EN EL PASADO
    if (startDate.getTime() <= now.getTime()) {
      return {
        valid: false,
        error: "No se pueden agendar citas en el pasado",
        suggestion: "Selecciona una fecha y hora futura"
      };
    }

    // 9. VALIDAR DURACIÓN DE LA CITA (si hay fecha de fin)
    if (params.end && (params.end.dateTime || params.end.date)) {
      const endDate = new Date(params.end.dateTime || params.end.date);
      
      if (endDate.getTime() <= startDate.getTime()) {
        return {
          valid: false,
          error: "La fecha de fin debe ser posterior a la fecha de inicio",
          suggestion: "Verifica que las fechas de inicio y fin estén correctas"
        };
      }
      
      // Validar duración máxima (si está configurada)
      const durationHours = (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60);
      const maxDurationHours = rules?.maxAppointmentDurationHours || 8; // 8 horas por defecto
      
      if (durationHours > maxDurationHours) {
        return {
          valid: false,
          error: `La duración de la cita no puede exceder ${maxDurationHours} horas`,
          suggestion: `Duración actual: ${durationHours.toFixed(1)} horas. Máximo permitido: ${maxDurationHours} horas`
        };
      }
    }

    // 10. VALIDAR INTERVALOS DE TIEMPO (si están configurados)
    if (rules?.timeSlotIntervalMinutes && params.start.dateTime) {
      const minutes = startDate.getMinutes();
      const interval = rules.timeSlotIntervalMinutes;
      
      if (minutes % interval !== 0) {
        const validMinutes = [];
        for (let i = 0; i < 60; i += interval) {
          validMinutes.push(i.toString().padStart(2, '0'));
        }
        
        return {
          valid: false,
          error: `La hora debe ser en intervalos de ${interval} minutos`,
          suggestion: `Minutos válidos: ${validMinutes.join(', ')} (ej: 10:${validMinutes[0]}, 10:${validMinutes[1]})`
        };
      }
    }

    return { valid: true };

  } catch (error) {
    this.logger.error('Error en validación de reglas de negocio:', error);
    return {
      valid: false,
      error: "Error al procesar la fecha",
      suggestion: "Verifica el formato de fecha proporcionado"
    };
  }
}

/**
 * HELPER: Formatear hora en formato legible
 */
private formatHour(hour: number): string {
  if (hour === 0) return '12:00 AM';
  if (hour < 12) return `${hour}:00 AM`;
  if (hour === 12) return '12:00 PM';
  return `${hour - 12}:00 PM`;
}

/**
 * HELPER: Formatear hora decimal (ej: 13.5 = 1:30 PM)
 */
private formatDecimalHour(decimalHour: number): string {
  const hour = Math.floor(decimalHour);
  const minutes = Math.round((decimalHour - hour) * 60);
  const minutesStr = minutes.toString().padStart(2, '0');
  
  if (hour === 0) return `12:${minutesStr} AM`;
  if (hour < 12) return `${hour}:${minutesStr} AM`;
  if (hour === 12) return `12:${minutesStr} PM`;
  return `${hour - 12}:${minutesStr} PM`;
}
  /**
   * Validación para acciones de mensajería
   */
  private validateMessagingAction(params: any, rules?: MessagingRules): ValidationResult {
    if (!rules?.enabled) {
      return { valid: true };
    }

    // Validar longitud del mensaje
    if (rules.maxMessageLength && params.body) {
      if (params.body.length > rules.maxMessageLength) {
        return {
          valid: false,
          error: `Mensaje demasiado largo (${params.body.length}/${rules.maxMessageLength} caracteres)`,
          suggestion: "Reduce la longitud del mensaje"
        };
      }
    }

    // Validar tipo de mensaje permitido
    if (rules.allowedTypes && params.type) {
      if (!rules.allowedTypes.includes(params.type)) {
        return {
          valid: false,
          error: `Tipo de mensaje '${params.type}' no permitido`,
          suggestion: `Tipos permitidos: ${rules.allowedTypes.join(', ')}`
        };
      }
    }

    // Validar palabras prohibidas
    if (rules.bannedWords && params.body) {
      const lowerBody = params.body.toLowerCase();
      for (const bannedWord of rules.bannedWords) {
        if (lowerBody.includes(bannedWord.toLowerCase())) {
          return {
            valid: false,
            error: "Mensaje contiene contenido no permitido",
            suggestion: "Revisa el contenido del mensaje"
          };
        }
      }
    }

    return { valid: true };
  }

  /**
   * Validación para eliminación de eventos
   */
  private validateDeleteAction(params: any, rules?: CalendarRules): ValidationResult {
    if (!rules?.enabled) {
      return { valid: true };
    }

    if (!params.eventId) {
      return {
        valid: false,
        error: "ID de evento requerido para eliminación"
      };
    }

    // Aquí podrías añadir reglas específicas para eliminación
    // Por ejemplo, no permitir eliminar eventos muy próximos
    
    return { valid: true };
  }

  /**
   * Validación general para otras acciones
   */
  private validateGeneralAction(params: any, rules?: any): ValidationResult {
    // Validaciones generales que aplican a cualquier acción
    return { valid: true };
  }

  /**
   * Obtiene las reglas de negocio del agente (con cache)
   */
  private async getAgentBusinessRules(agentId: string): Promise<AgentBusinessRules> {
    const now = Date.now();
    
    // Verificar cache
    if (this.agentRulesCache.has(agentId) && 
        this.cacheExpiry.has(agentId) && 
        this.cacheExpiry.get(agentId)! > now) {
      return this.agentRulesCache.get(agentId)!;
    }

    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.AGENTS);
      const agent = await tableClient.getEntity('agent', agentId);
      
      let businessRules: AgentBusinessRules = {};
      
      if (agent.businessRules) {
        if (typeof agent.businessRules === 'string') {
          try {
            businessRules = JSON.parse(agent.businessRules);
          } catch (e) {
            this.logger.warn(`Error parseando businessRules para agente ${agentId}:`, e);
          }
        } else if (typeof agent.businessRules === 'object') {
          businessRules = agent.businessRules as AgentBusinessRules;
        }
      }

      // Aplicar reglas por defecto si no existen
      if (!businessRules.calendar) {
        businessRules.calendar = {
          enabled: true,
          workingDays: [1, 2, 3, 4, 5], // Lunes a viernes por defecto
          workingHours: { start: 9, end: 18 },
          minAdvanceHours: 24,
          maxAdvanceWeeks: 8,
          timeZone: 'America/Mexico_City',
          allowSameDayBooking: false
        };
      }

      // Cache del resultado
      this.agentRulesCache.set(agentId, businessRules);
      this.cacheExpiry.set(agentId, now + this.CACHE_TTL);
      
      return businessRules;
      
    } catch (error) {
      this.logger.error(`Error obteniendo reglas de agente ${agentId}:`, error);
      
      // Retornar reglas por defecto en caso de error
      return {
        calendar: {
          enabled: true,
          workingDays: [1, 2, 3, 4, 5],
          workingHours: { start: 9, end: 18 },
          minAdvanceHours: 24,
          allowSameDayBooking: false
        }
      };
    }
  }

  /**
   * Actualiza las reglas de un agente y limpia el cache
   */
  async updateAgentBusinessRules(agentId: string, newRules: AgentBusinessRules): Promise<void> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.AGENTS);
      
      await tableClient.updateEntity({
        partitionKey: 'agent',
        rowKey: agentId,
        businessRules: JSON.stringify(newRules),
        updatedAt: Date.now()
      }, "Merge");

      // Limpiar cache
      this.agentRulesCache.delete(agentId);
      this.cacheExpiry.delete(agentId);
      
      this.logger.info(`✅ Reglas de negocio actualizadas para agente ${agentId}`);
      
    } catch (error) {
      this.logger.error(`Error actualizando reglas de agente ${agentId}:`, error);
      throw error;
    }
  }

  /**
   * Limpia el cache de reglas (útil para testing o actualizaciones manuales)
   */
  clearCache(agentId?: string): void {
    if (agentId) {
      this.agentRulesCache.delete(agentId);
      this.cacheExpiry.delete(agentId);
    } else {
      this.agentRulesCache.clear();
      this.cacheExpiry.clear();
    }
  }
  
}