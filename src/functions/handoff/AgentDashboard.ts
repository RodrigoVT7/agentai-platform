// src/functions/handoff/AgentDashboard.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";
import { JwtService } from "../../shared/utils/jwt.service";
import { StorageService } from "../../shared/services/storage.service";
import { STORAGE_TABLES } from "../../shared/constants";
import { HandoffStatus, AgentStatus } from "../../shared/models/handoff.model";

/**
 * Endpoint principal para el dashboard de agentes humanos
 * GET /api/handoff/dashboard
 */
export async function AgentDashboard(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const logger = createLogger(context);

  try {
    // Verificar autenticación
    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return { status: 401, jsonBody: { error: "Se requiere autenticación" } };
    }

    const token = authHeader.split(' ')[1];
    const jwtService = new JwtService();

    let payload;
    try {
      payload = jwtService.verifyToken(token);
    } catch (error) {
      return { status: 401, jsonBody: { error: "Token inválido o expirado" } };
    }

    const agentUserId = payload.userId;
    if (!agentUserId) {
      return { status: 401, jsonBody: { error: "Token no contiene userId" } };
    }

    const storageService = new StorageService();

    // Obtener información del dashboard
    const dashboardData = await getDashboardData(agentUserId, storageService, logger);

    return {
      status: 200,
      jsonBody: dashboardData
    };

  } catch (error) {
    logger.error("Error al obtener dashboard de agente:", error);
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

async function getDashboardData(agentUserId: string, storageService: StorageService, logger: any) {
  const handoffTable = storageService.getTableClient(STORAGE_TABLES.HANDOFFS);
  const agentStatusTable = storageService.getTableClient(STORAGE_TABLES.AGENT_STATUS);
  const conversationTable = storageService.getTableClient(STORAGE_TABLES.CONVERSATIONS);

  // Obtener estado actual del agente
  let agentStatus = AgentStatus.OFFLINE;
  let currentHandoffId = null;
  try {
    const statusEntity = await agentStatusTable.getEntity(agentUserId, 'current');
    agentStatus = statusEntity.status as AgentStatus;
    currentHandoffId = statusEntity.currentHandoffId as string | null;
  } catch (error) {
    logger.warn(`No se encontró estado para agente ${agentUserId}, asumiendo OFFLINE`);
  }

  // Obtener handoffs pendientes (cola general)
  const pendingHandoffs: any[] = [];
  const pendingEntities = handoffTable.listEntities({
    queryOptions: { filter: `status eq '${HandoffStatus.PENDING}' and isActive eq true` }
  });
  
  for await (const handoff of pendingEntities) {
    // Enriquecer con datos de conversación
    try {
      const conversation = await conversationTable.getEntity(handoff.agentId as string, handoff.conversationId as string);
      pendingHandoffs.push({
        id: handoff.rowKey,
        agentId: handoff.agentId,
        conversationId: handoff.conversationId,
        userId: handoff.userId,
        reason: handoff.reason,
        createdAt: handoff.createdAt,
        queuedAt: handoff.queuedAt,
        waitTime: Date.now() - (handoff.queuedAt as number || handoff.createdAt as number),
        conversation: {
          sourceChannel: conversation.sourceChannel,
          userMetadata: conversation.metadata ? 
            (typeof conversation.metadata === 'string' ? JSON.parse(conversation.metadata) : conversation.metadata) 
            : {}
        }
      });
    } catch (convError) {
      logger.warn(`Error al obtener conversación ${handoff.conversationId}:`, convError);
      // Incluir handoff sin datos de conversación
      pendingHandoffs.push({
        id: handoff.rowKey,
        agentId: handoff.agentId,
        conversationId: handoff.conversationId,
        userId: handoff.userId,
        reason: handoff.reason,
        createdAt: handoff.createdAt,
        queuedAt: handoff.queuedAt,
        waitTime: Date.now() - (handoff.queuedAt as number || handoff.createdAt as number),
        conversation: null
      });
    }
  }

  // Obtener handoffs asignados a este agente
  const myHandoffs: any[] = [];
  const myHandoffEntities = handoffTable.listEntities({
    queryOptions: { filter: `assignedAgentId eq '${agentUserId}' and status eq '${HandoffStatus.ACTIVE}' and isActive eq true` }
  });

  for await (const handoff of myHandoffEntities) {
    try {
      const conversation = await conversationTable.getEntity(handoff.agentId as string, handoff.conversationId as string);
      myHandoffs.push({
        id: handoff.rowKey,
        agentId: handoff.agentId,
        conversationId: handoff.conversationId,
        userId: handoff.userId,
        reason: handoff.reason,
        assignedAt: handoff.assignedAt,
        activeDuration: Date.now() - (handoff.assignedAt as number || handoff.createdAt as number),
        conversation: {
          sourceChannel: conversation.sourceChannel,
          userMetadata: conversation.metadata ? 
            (typeof conversation.metadata === 'string' ? JSON.parse(conversation.metadata) : conversation.metadata) 
            : {}
        }
      });
    } catch (convError) {
      logger.warn(`Error al obtener conversación ${handoff.conversationId}:`, convError);
    }
  }

  // Calcular estadísticas
  const stats = {
    pendingCount: pendingHandoffs.length,
    myActiveCount: myHandoffs.length,
    averageWaitTime: pendingHandoffs.length > 0 ? 
      pendingHandoffs.reduce((sum, h) => sum + h.waitTime, 0) / pendingHandoffs.length : 0,
    oldestPending: pendingHandoffs.length > 0 ? 
      Math.max(...pendingHandoffs.map(h => h.waitTime)) : 0
  };

  return {
    agentStatus,
    currentHandoffId,
    pendingHandoffs: pendingHandoffs.sort((a, b) => a.createdAt - b.createdAt), // Más antiguos primero
    myHandoffs,
    stats,
    lastUpdated: Date.now()
  };
}

app.http('AgentDashboard', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'handoff/dashboard',
  handler: AgentDashboard
});

/**
 * Endpoint para obtener detalles de una conversación específica
 * GET /api/handoff/conversation/{conversationId}
 */
export async function GetConversationDetails(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const logger = createLogger(context);

  try {
    // Verificar autenticación
    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return { status: 401, jsonBody: { error: "Se requiere autenticación" } };
    }

    const token = authHeader.split(' ')[1];
    const jwtService = new JwtService();

    let payload;
    try {
      payload = jwtService.verifyToken(token);
    } catch (error) {
      return { status: 401, jsonBody: { error: "Token inválido o expirado" } };
    }

    const agentUserId = payload.userId;
    const conversationId = request.params.conversationId;
    const agentId = request.query.get('agentId');

    if (!conversationId || !agentId) {
      return { status: 400, jsonBody: { error: "Se requiere conversationId y agentId" } };
    }

    const storageService = new StorageService();
    const conversationTable = storageService.getTableClient(STORAGE_TABLES.CONVERSATIONS);
    const messagesTable = storageService.getTableClient(STORAGE_TABLES.MESSAGES);

    // Obtener conversación
    const conversation = await conversationTable.getEntity(agentId, conversationId);

    // Obtener mensajes de la conversación (últimos 50)
    const messages: any[] = [];
    const messageEntities = messagesTable.listEntities({
      queryOptions: { filter: `PartitionKey eq '${conversationId}'` }
    });

    for await (const msg of messageEntities) {
      messages.push({
        id: msg.rowKey,
        content: msg.content,
        role: msg.role,
        senderId: msg.senderId,
        timestamp: msg.timestamp,
        messageType: msg.messageType,
        status: msg.status,
        attachments: msg.attachments ? 
          (typeof msg.attachments === 'string' ? JSON.parse(msg.attachments) : msg.attachments) 
          : undefined,
        metadata: msg.metadata ? 
          (typeof msg.metadata === 'string' ? JSON.parse(msg.metadata) : msg.metadata) 
          : undefined
      });
    }

    // Ordenar mensajes por timestamp
    messages.sort((a, b) => a.timestamp - b.timestamp);

    // Obtener últimos 50 mensajes
    const recentMessages = messages.slice(-50);

    // Parsear metadata de conversación
    let conversationMetadata = {};
    if (conversation.metadata) {
      try {
        conversationMetadata = typeof conversation.metadata === 'string' ? 
          JSON.parse(conversation.metadata) : conversation.metadata;
      } catch (e) {
        logger.warn(`Error parseando metadata de conversación ${conversationId}:`, e);
      }
    }

    return {
      status: 200,
      jsonBody: {
        conversation: {
          id: conversation.rowKey,
          agentId: conversation.agentId,
          userId: conversation.userId,
          endUserId: conversation.endUserId,
          status: conversation.status,
          sourceChannel: conversation.sourceChannel,
          startDate: conversation.startDate,
          updatedAt: conversation.updatedAt,
          metadata: conversationMetadata
        },
        messages: recentMessages,
        messageCount: messages.length,
        lastMessage: recentMessages.length > 0 ? recentMessages[recentMessages.length - 1] : null
      }
    };

  } catch (error) {
    logger.error("Error al obtener detalles de conversación:", error);
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

app.http('GetConversationDetails', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'handoff/conversation/{conversationId}',
  handler: GetConversationDetails
});

/**
 * Endpoint para obtener handoffs asignados a un agente específico
 * GET /api/handoff/my-assignments
 */
export async function GetMyAssignments(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const logger = createLogger(context);

  try {
    // Verificar autenticación
    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return { status: 401, jsonBody: { error: "Se requiere autenticación" } };
    }

    const token = authHeader.split(' ')[1];
    const jwtService = new JwtService();

    let payload;
    try {
      payload = jwtService.verifyToken(token);
    } catch (error) {
      return { status: 401, jsonBody: { error: "Token inválido o expirado" } };
    }

    const agentUserId = payload.userId;
    const storageService = new StorageService();
    const handoffTable = storageService.getTableClient(STORAGE_TABLES.HANDOFFS);
    const conversationTable = storageService.getTableClient(STORAGE_TABLES.CONVERSATIONS);

    // Obtener handoffs activos asignados a este agente
    const myHandoffs: any[] = [];
    const handoffEntities = handoffTable.listEntities({
      queryOptions: { 
        filter: `assignedAgentId eq '${agentUserId}' and status eq '${HandoffStatus.ACTIVE}' and isActive eq true` 
      }
    });

    for await (const handoff of handoffEntities) {
      try {
        // Obtener datos de la conversación
        const conversation = await conversationTable.getEntity(
          handoff.agentId as string, 
          handoff.conversationId as string
        );

        // Obtener último mensaje de la conversación
        const messagesTable = storageService.getTableClient(STORAGE_TABLES.MESSAGES);
        let lastMessage = null;
        const messages = messagesTable.listEntities({
          queryOptions: { filter: `PartitionKey eq '${handoff.conversationId}'` }
        });

        const allMessages: any[] = [];
        for await (const msg of messages) {
          allMessages.push(msg);
        }

        if (allMessages.length > 0) {
          allMessages.sort((a, b) => (b.timestamp as number) - (a.timestamp as number));
          const latestMsg = allMessages[0];
          lastMessage = {
            content: latestMsg.content,
            role: latestMsg.role,
            timestamp: latestMsg.timestamp,
            messageType: latestMsg.messageType
          };
        }

        myHandoffs.push({
          id: handoff.rowKey,
          agentId: handoff.agentId,
          conversationId: handoff.conversationId,
          userId: handoff.userId,
          reason: handoff.reason,
          assignedAt: handoff.assignedAt,
          activeDuration: Date.now() - (handoff.assignedAt as number || handoff.createdAt as number),
          conversation: {
            sourceChannel: conversation.sourceChannel,
            status: conversation.status,
            metadata: conversation.metadata ? 
              (typeof conversation.metadata === 'string' ? JSON.parse(conversation.metadata) : conversation.metadata) 
              : {}
          },
          lastMessage,
          unreadCount: 0 // TODO: Implementar conteo de mensajes no leídos
        });

      } catch (convError) {
        logger.warn(`Error al obtener datos para handoff ${handoff.rowKey}:`, convError);
        // Incluir handoff básico sin datos enriquecidos
        myHandoffs.push({
          id: handoff.rowKey,
          agentId: handoff.agentId,
          conversationId: handoff.conversationId,
          userId: handoff.userId,
          reason: handoff.reason,
          assignedAt: handoff.assignedAt,
          activeDuration: Date.now() - (handoff.assignedAt as number || handoff.createdAt as number),
          conversation: null,
          lastMessage: null,
          unreadCount: 0
        });
      }
    }

    // Ordenar por asignación más reciente primero
    myHandoffs.sort((a, b) => (b.assignedAt || 0) - (a.assignedAt || 0));

    return {
      status: 200,
      jsonBody: {
        assignments: myHandoffs,
        count: myHandoffs.length,
        lastUpdated: Date.now()
      }
    };

  } catch (error) {
    logger.error("Error al obtener asignaciones del agente:", error);
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

app.http('GetMyAssignments', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'handoff/my-assignments',
  handler: GetMyAssignments
});

/**
 * Endpoint para obtener estadísticas del agente
 * GET /api/handoff/my-stats
 */
export async function GetMyStats(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const logger = createLogger(context);

  try {
    // Verificar autenticación
    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return { status: 401, jsonBody: { error: "Se requiere autenticación" } };
    }

    const token = authHeader.split(' ')[1];
    const jwtService = new JwtService();

    let payload;
    try {
      payload = jwtService.verifyToken(token);
    } catch (error) {
      return { status: 401, jsonBody: { error: "Token inválido o expirado" } };
    }

    const agentUserId = payload.userId;
    const period = request.query.get('period') || 'today'; // today, week, month
    
    const storageService = new StorageService();
    const handoffTable = storageService.getTableClient(STORAGE_TABLES.HANDOFFS);

    // Calcular rango de fechas
    const now = Date.now();
    let startTime: number;
    
    switch (period) {
      case 'week':
        startTime = now - (7 * 24 * 60 * 60 * 1000);
        break;
      case 'month':
        startTime = now - (30 * 24 * 60 * 60 * 1000);
        break;
      default: // today
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        startTime = today.getTime();
        break;
    }

    // Obtener handoffs del agente en el período
    const handoffs: any[] = [];
    const handoffEntities = handoffTable.listEntities({
      queryOptions: { 
        filter: `assignedAgentId eq '${agentUserId}' and assignedAt ge ${startTime}L` 
      }
    });

    for await (const handoff of handoffEntities) {
      handoffs.push(handoff);
    }

    // Calcular estadísticas
    const completedHandoffs = handoffs.filter(h => h.status === HandoffStatus.COMPLETED);
    const activeHandoffs = handoffs.filter(h => h.status === HandoffStatus.ACTIVE);
    
    const totalHandoffs = handoffs.length;
    const completedCount = completedHandoffs.length;
    const activeCount = activeHandoffs.length;
    
    // Calcular tiempo promedio de resolución
    const completedWithDuration = completedHandoffs.filter(h => h.assignedAt && h.completedAt);
    const averageResolutionTime = completedWithDuration.length > 0 ?
      completedWithDuration.reduce((sum, h) => sum + ((h.completedAt as number) - (h.assignedAt as number)), 0) / completedWithDuration.length
      : 0;

    // Calcular tiempo total activo
    const totalActiveTime = completedWithDuration.reduce((sum, h) => 
      sum + ((h.completedAt as number) - (h.assignedAt as number)), 0
    ) + activeHandoffs.reduce((sum, h) => 
      sum + (now - (h.assignedAt as number || h.createdAt as number)), 0
    );

    return {
      status: 200,
      jsonBody: {
        period,
        stats: {
          totalHandoffs,
          completedCount,
          activeCount,
          completionRate: totalHandoffs > 0 ? (completedCount / totalHandoffs) * 100 : 0,
          averageResolutionTime: Math.round(averageResolutionTime / (1000 * 60)), // en minutos
          totalActiveTime: Math.round(totalActiveTime / (1000 * 60)), // en minutos
        },
        breakdown: {
          byStatus: {
            [HandoffStatus.COMPLETED]: completedCount,
            [HandoffStatus.ACTIVE]: activeCount,
            [HandoffStatus.CANCELLED]: handoffs.filter(h => h.status === HandoffStatus.CANCELLED).length
          }
        },
        lastUpdated: Date.now()
      }
    };

  } catch (error) {
    logger.error("Error al obtener estadísticas del agente:", error);
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

app.http('GetMyStats', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'handoff/my-stats',
  handler: GetMyStats
});