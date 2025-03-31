// src/shared/handlers/agents/agentStatsHandler.ts
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";

interface StatsOptions {
  period?: string;  // 'day', 'week', 'month'
  from?: number;    // timestamp
  to?: number;      // timestamp
}

interface TimelinePoint {
  time: number;
  label: string;
  conversations: number;
  messages: number;
}

export class AgentStatsHandler {
  private storageService: StorageService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }
  
  async execute(agentId: string, userId: string, options: StatsOptions): Promise<any> {
    try {
      // Verificar acceso al agente
      await this.verifyAgentAccess(agentId, userId);
      
      // Determinar rango de fechas
      const { from, to } = this.calculateDateRange(options);
      
      // Obtener estadísticas
      const conversationsStats = await this.getConversationsStats(agentId, from, to);
      const messagesStats = await this.getMessagesStats(agentId, from, to);
      const handoffStats = await this.getHandoffStats(agentId, from, to);
      const feedbackStats = await this.getFeedbackStats(agentId, from, to);
      
      // Si se solicita por período, agrupar por día/semana/mes
      const groupedStats = this.groupStatsByPeriod(
        options.period || 'day',
        from,
        to,
        conversationsStats,
        messagesStats
      );
      
      return {
        agentId,
        period: options.period || 'day',
        from,
        to,
        totals: {
          conversations: conversationsStats.total,
          messages: messagesStats.total,
          handoffs: handoffStats.total,
          avgMessagesPerConversation: conversationsStats.total 
            ? Number((messagesStats.total / conversationsStats.total).toFixed(2))
            : 0,
          positiveRating: feedbackStats.positive,
          negativeRating: feedbackStats.negative
        },
        timeline: groupedStats
      };
    } catch (error: unknown) {
      this.logger.error(`Error al obtener estadísticas para el agente ${agentId}:`, error);
      
      if (error && typeof error === 'object' && 'statusCode' in error) {
        throw error;
      }
      
      throw createAppError(500, 'Error al obtener estadísticas');
    }
  }
  
  private async verifyAgentAccess(agentId: string, userId: string): Promise<void> {
    try {
      // Verificar si el agente existe
      const agentsTable = this.storageService.getTableClient(STORAGE_TABLES.AGENTS);
      
      try {
        const agent = await agentsTable.getEntity('agent', agentId);
        
        // Si el usuario es propietario, tiene acceso
        if (agent.userId === userId) {
          return;
        }
      } catch (error) {
        throw createAppError(404, 'Agente no encontrado');
      }
      
      // Si no es propietario, verificar si tiene algún rol
      const rolesTable = this.storageService.getTableClient(STORAGE_TABLES.USER_ROLES);
      const roles = rolesTable.listEntities({
        queryOptions: { filter: `agentId eq '${agentId}' and userId eq '${userId}' and isActive eq true` }
      });
      
      let hasRole = false;
      for await (const role of roles) {
        hasRole = true;
        break;
      }
      
      if (!hasRole) {
        throw createAppError(403, 'No tienes permiso para acceder a este agente');
      }
    } catch (error) {
      if (error && typeof error === 'object' && 'statusCode' in error) {
        throw error;
      }
      throw createAppError(500, 'Error al verificar acceso al agente');
    }
  }
  
  private calculateDateRange(options: StatsOptions): { from: number, to: number } {
    const now = Date.now();
    const to = options.to || now;
    let from: number;
    
    if (options.from) {
      from = options.from;
    } else {
      // Calcular "from" basado en el período
      const period = options.period || 'day';
      const day = 24 * 60 * 60 * 1000;
      
      switch (period) {
        case 'day':
          from = to - day;
          break;
        case 'week':
          from = to - 7 * day;
          break;
        case 'month':
          from = to - 30 * day;
          break;
        default:
          from = to - day;
      }
    }
    
    return { from, to };
  }
  
  private async getConversationsStats(agentId: string, from: number, to: number): Promise<any> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.CONVERSATIONS);
      
      let total = 0;
      const hourlyCount: Record<number, number> = {};
      
      // Consultar conversaciones en el rango de fechas
      const conversations = tableClient.listEntities({
        queryOptions: { 
          filter: `agentId eq '${agentId}' and createdAt ge ${from} and createdAt le ${to}` 
        }
      });
      
      for await (const conversation of conversations) {
        total++;
        
        // Agrupar por hora para timeline
        const createdAt = this.getNumberValue(conversation.createdAt);
        
        if (createdAt) {
          const date = new Date(createdAt);
          const hour = date.getHours();
          hourlyCount[hour] = (hourlyCount[hour] || 0) + 1;
        }
      }
      
      return {
        total,
        hourlyCount
      };
    } catch (error) {
      this.logger.error(`Error al obtener estadísticas de conversaciones:`, error);
      return { total: 0, hourlyCount: {} };
    }
  }
  
  private async getMessagesStats(agentId: string, from: number, to: number): Promise<any> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.MESSAGES);
      
      let total = 0;
      let userMessages = 0;
      let botMessages = 0;
      const hourlyCount: Record<number, number> = {};
      
      // Consultar mensajes en el rango de fechas
      const messages = tableClient.listEntities({
        queryOptions: { 
          filter: `agentId eq '${agentId}' and timestamp ge ${from} and timestamp le ${to}` 
        }
      });
      
      for await (const message of messages) {
        total++;
        
        // Contar tipos de mensajes
        const role = message.role as string;
        if (role === 'user') {
          userMessages++;
        } else if (role === 'assistant') {
          botMessages++;
        }
        
        // Agrupar por hora para timeline
        const timestamp = this.getNumberValue(message.timestamp);
        
        if (timestamp) {
          const date = new Date(timestamp);
          const hour = date.getHours();
          hourlyCount[hour] = (hourlyCount[hour] || 0) + 1;
        }
      }
      
      return {
        total,
        userMessages,
        botMessages,
        hourlyCount
      };
    } catch (error) {
      this.logger.error(`Error al obtener estadísticas de mensajes:`, error);
      return { total: 0, userMessages: 0, botMessages: 0, hourlyCount: {} };
    }
  }
  
  private async getHandoffStats(agentId: string, from: number, to: number): Promise<any> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.HANDOFFS);
      
      let total = 0;
      let completed = 0;
      let cancelled = 0;
      let avgWaitTime = 0;
      let totalWaitTime = 0;
      
      // Consultar handoffs en el rango de fechas
      const handoffs = tableClient.listEntities({
        queryOptions: { 
          filter: `agentId eq '${agentId}' and createdAt ge ${from} and createdAt le ${to}` 
        }
      });
      
      for await (const handoff of handoffs) {
        total++;
        
        // Contar estado
        const status = handoff.status as string;
        if (status === 'completed') {
          completed++;
          
          // Calcular tiempo de espera
          const startedAt = this.getNumberValue(handoff.startedAt);
          const createdAt = this.getNumberValue(handoff.createdAt);
          
          if (startedAt && createdAt) {
            const waitTime = startedAt - createdAt;
            totalWaitTime += waitTime;
          }
        } else if (status === 'cancelled') {
          cancelled++;
        }
      }
      
      // Calcular tiempo promedio de espera
      if (completed > 0) {
        avgWaitTime = totalWaitTime / completed;
      }
      
      return {
        total,
        completed,
        cancelled,
        avgWaitTime
      };
    } catch (error) {
      this.logger.error(`Error al obtener estadísticas de handoffs:`, error);
      return { total: 0, completed: 0, cancelled: 0, avgWaitTime: 0 };
    }
  }
  
  private async getFeedbackStats(agentId: string, from: number, to: number): Promise<any> {
    try {
      // Asumiendo que hay una tabla de feedback
      const tableClient = this.storageService.getTableClient('feedback');
      
      let positive = 0;
      let negative = 0;
      
      // Consultar feedback en el rango de fechas
      const feedbacks = tableClient.listEntities({
        queryOptions: { 
          filter: `agentId eq '${agentId}' and createdAt ge ${from} and createdAt le ${to}` 
        }
      });
      
      for await (const feedback of feedbacks) {
        const rating = feedback.rating;
        
        if (
          (typeof rating === 'string' && (rating === 'positive' || rating === 'thumbsUp')) || 
          (typeof rating === 'number' && rating > 3)
        ) {
          positive++;
        } else {
          negative++;
        }
      }
      
      return {
        total: positive + negative,
        positive,
        negative
      };
    } catch (error) {
      this.logger.error(`Error al obtener estadísticas de feedback:`, error);
      return { total: 0, positive: 0, negative: 0 };
    }
  }
  
  private groupStatsByPeriod(
    period: string,
    from: number,
    to: number,
    conversationsStats: any,
    messagesStats: any
  ): TimelinePoint[] {
    const result: TimelinePoint[] = [];
    const day = 24 * 60 * 60 * 1000;
    
    // Determinar tamaño de intervalo
    let interval = day;
    if (period === 'week') {
      interval = day / 24; // Cada hora
    } else if (period === 'month') {
      interval = day; // Cada día
    } else {
      interval = day / 24; // Por defecto cada hora
    }
    
    // Crear puntos de tiempo
    for (let time = from; time <= to; time += interval) {
      const date = new Date(time);
      
      let label = '';
      if (period === 'month') {
        label = date.toLocaleDateString();
      } else {
        label = date.toLocaleString();
      }
      
      result.push({
        time,
        label,
        conversations: 0,
        messages: 0
      });
    }
    
    // Distribuir datos de conversaciones
    for (const hour in conversationsStats.hourlyCount) {
      const count = conversationsStats.hourlyCount[hour];
      // Encontrar el punto de tiempo al que pertenece esta hora
      for (let i = 0; i < result.length - 1; i++) {
        const currentPoint = result[i];
        const nextPoint = result[i + 1];
        
        // Convertir hora a timestamp
        const hourDate = new Date();
        hourDate.setHours(parseInt(hour), 0, 0, 0);
        const hourTimestamp = hourDate.getTime();
        
        if (hourTimestamp >= currentPoint.time && hourTimestamp < nextPoint.time) {
          currentPoint.conversations += count;
          break;
        }
      }
    }
    
    // Distribuir datos de mensajes
    for (const hour in messagesStats.hourlyCount) {
      const count = messagesStats.hourlyCount[hour];
      // Encontrar el punto de tiempo al que pertenece esta hora
      for (let i = 0; i < result.length - 1; i++) {
        const currentPoint = result[i];
        const nextPoint = result[i + 1];
        
        // Convertir hora a timestamp
        const hourDate = new Date();
        hourDate.setHours(parseInt(hour), 0, 0, 0);
        const hourTimestamp = hourDate.getTime();
        
        if (hourTimestamp >= currentPoint.time && hourTimestamp < nextPoint.time) {
          currentPoint.messages += count;
          break;
        }
      }
    }
    
    return result;
  }
  
  /**
   * Convierte un valor desconocido a número si es posible
   */
  private getNumberValue(value: unknown): number | null {
    if (typeof value === 'number') {
      return value;
    } else if (typeof value === 'string') {
      const num = parseInt(value, 10);
      return isNaN(num) ? null : num;
    }
    return null;
  }
}