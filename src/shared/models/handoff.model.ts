// src/shared/models/handoff.model.ts
import { MessageType } from "./conversation.model"; // Importar si usas MessageType

/**
 * Define los posibles estados de un handoff.
 */
export enum HandoffStatus {
  PENDING = 'pending',       // Esperando asignación de agente humano
  ACTIVE = 'active',         // Agente humano asignado y conversando
  COMPLETED = 'completed',     // Handoff finalizado por el agente
  CANCELLED = 'cancelled',     // Handoff cancelado (ej. usuario abandona)
  EXPIRED = 'expired',       // Handoff expiró sin ser atendido
  FAILED = 'failed'          // Ocurrió un error durante el handoff
}

/**
 * Define los posibles estados de disponibilidad de un agente humano.
 */
export enum AgentStatus {
  ONLINE = 'online',         // Conectado y disponible
  OFFLINE = 'offline',       // Desconectado
  BUSY = 'busy',           // Conectado pero ocupado (ej. en otra conversación)
  BREAK = 'break',         // Conectado pero en pausa/descanso
  AVAILABLE = 'available'    // Alias para online, indica explícitamente disponibilidad
}

/**
 * Representa un registro en la tabla 'handoffs'.
 */
export interface Handoff {
  id: string;
  agentId: string;
  conversationId: string;
  userId: string; // ID del usuario final
  status: HandoffStatus;
  reason?: string;
  initiatedBy: string;
  createdAt: number;
  queuedAt?: number;
  assignedAgentId?: string;
  assignedAt?: number;
  completedBy?: string;
  completedAt?: number;
  summary?: string;
  resolution?: string;
  metadata?: Record<string, any>;
  updatedAt?: number;
  isActive: boolean;
  notificationMethod?: string; 
  notifiedAgents?: string; 
}

/**
 * Representa un registro en la tabla 'agentstatus'.
 */
export interface AgentStatusRecord {
  agentId: string;         // ID del agente humano (PartitionKey)
  // RowKey podría ser 'current' o similar
  status: AgentStatus;       // Estado actual
  message?: string;        // Mensaje opcional (ej. "En reunión hasta las 3 PM")
  lastStatusChange: number; // Timestamp del último cambio
  currentHandoffId?: string; // ID del handoff activo (si está BUSY)
}

/**
 * Datos esperados para iniciar un handoff.
 */
export interface HandoffInitiateRequest {
  conversationId: string;
  agentId: string;         // ID del bot/agente original
  reason?: string;
  initiatedBy?: string;    // 'user', 'bot', 'system'
}

/**
 * Datos esperados para que un agente envíe un mensaje.
 */
export interface AgentMessageRequest {
  handoffId: string;
  content: string;
  messageType?: MessageType; // Opcional, default TEXT
  attachments?: any;       // Opcional, definir estructura si es necesario
}

/**
 * Datos esperados para completar un handoff.
 */
export interface HandoffCompleteRequest {
  handoffId: string;
  summary?: string;        // Resumen de la interacción
  resolution?: string;     // Cómo se resolvió
  returnToBot?: boolean;   // Indica si la conversación debe volver al bot (default: false = ENDED)
}

/**
 * Datos esperados para actualizar el estado de un agente.
 */
export interface AgentStatusUpdateRequest {
    status: AgentStatus;
    message?: string;
}