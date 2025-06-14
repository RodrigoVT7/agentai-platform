// src/shared/handlers/conversation/intelligentWorkflowHandler.ts
import { Logger } from "../../utils/logger";
import { IntegrationExecutorHandler } from "../integrations/integrationExecutorHandler";
import { IntegrationAction } from "../../models/integration.model";
import { ContextResult, IntegrationInfo } from "../../models/conversation.model";

// Definición de workflows obligatorios
interface WorkflowStep {
  toolName: string;
  action: string;
  required: boolean;
  conditional?: string; // Condición para ejecutar este step
  parameters?: Record<string, any>;
}

interface WorkflowDefinition {
  name: string;
  triggers: string[];
  priority: number; // Mayor número = mayor prioridad
  steps: WorkflowStep[];
  description: string;
}

interface WorkflowResult {
  workflowExecuted: boolean;
  workflowName?: string;
  results: Array<{
    stepName: string;
    success: boolean;
    result: any;
    error?: string;
  }>;
  enhancedContext: string; // Contexto adicional para el LLM
}

export class IntelligentWorkflowHandler {
  private logger: Logger;
  private integrationExecutor: IntegrationExecutorHandler;

  // WORKFLOWS DEFINIDOS - Aquí está la inteligencia
  private workflows: WorkflowDefinition[] = [
    {
      name: "appointment_management",
      triggers: [
        "cita", "citas", "appointment", "appointments", "agendar", "programar", 
        "schedule", "meeting", "reunión", "consulta", "consultas",
        "cambiar mi cita", "mover mi cita", "reagendar", "cancelar mi cita",
        "modificar mi cita", "eliminar mi cita", "borrar mi cita"
      ],
      priority: 10,
      steps: [
        {
          toolName: "getMyBookedCalendarEvents",
          action: "getMyBookedEvents", 
          required: true,
          parameters: {
            startDate: new Date().toISOString(),
            endDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
          }
        }
      ],
      description: "Siempre verificar citas existentes cuando se menciona cualquier palabra relacionada con citas"
    },
    {
      name: "check_my_appointments",
      triggers: [
        "qué citas tengo", "cuáles son mis citas", "mis citas", "my appointments",
        "tengo citas", "ver mis citas", "mostrar mis citas", "listar mis citas",
        "cuántas citas tengo", "check my appointments", "show my appointments"
      ],
      priority: 15,
      steps: [
        {
          toolName: "getMyBookedCalendarEvents", 
          action: "getMyBookedEvents",
          required: true,
          parameters: {
            startDate: new Date().toISOString(),
            endDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
          }
        }
      ],
      description: "Consultar citas cuando el usuario pregunta específicamente por ellas"
    },
    {
      name: "reschedule_detection",
      triggers: [
        "cambiar", "mover", "reagendar", "modificar", "actualizar",
        "reschedule", "change", "move", "update"
      ],
      priority: 12,
      steps: [
        {
          toolName: "getMyBookedCalendarEvents",
          action: "getMyBookedEvents", 
          required: true,
          parameters: {
            startDate: new Date().toISOString(),
            endDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
          }
        }
      ],
      description: "Verificar citas existentes cuando se detecta intención de modificación"
    }
  ];

  constructor(logger: Logger) {
    this.logger = logger;
    this.integrationExecutor = new IntegrationExecutorHandler(logger);
  }

  /**
   * PUNTO PRINCIPAL: Detecta y ejecuta workflows automáticamente
   */
  async detectAndExecuteWorkflow(
    userMessage: string,
    context: ContextResult,
    conversationId: string,
    userId: string
  ): Promise<WorkflowResult> {
    
    const userMessageLower = userMessage.toLowerCase();
    
    // 1. DETECTAR QUÉ WORKFLOW APLICAR
    const matchedWorkflow = this.findMatchingWorkflow(userMessageLower);
    
    if (!matchedWorkflow) {
      return {
        workflowExecuted: false,
        results: [],
        enhancedContext: ""
      };
    }

    this.logger.info(`🔄 Workflow detectado: "${matchedWorkflow.name}" para mensaje: "${userMessage.substring(0, 50)}..."`);

    // 2. EJECUTAR STEPS DEL WORKFLOW
    const results: WorkflowResult['results'] = [];
    let enhancedContext = `\n\n### 🤖 INFORMACIÓN OBTENIDA AUTOMÁTICAMENTE (${matchedWorkflow.name}):\n`;

    for (const step of matchedWorkflow.steps) {
      try {
        // Encontrar la integración necesaria
        const integration = this.findRequiredIntegration(step.toolName, context.activeIntegrations || []);
        
        if (!integration) {
          this.logger.warn(`⚠️ No se encontró integración activa para herramienta: ${step.toolName}`);
          results.push({
            stepName: step.toolName,
            success: false,
            result: null,
            error: `Integración no disponible para ${step.toolName}`
          });
          continue;
        }

        // Ejecutar la acción
        const actionRequest: IntegrationAction = {
          integrationId: integration.id,
          action: step.action,
          parameters: step.parameters || {},
          userId: userId,
          conversationId: conversationId,
          messageId: `workflow-${Date.now()}`,
          async: false
        };

        this.logger.info(`🔧 Ejecutando step: ${step.toolName} -> ${step.action}`);
        const stepResult = await this.integrationExecutor.execute(actionRequest, userId);

        if (stepResult.success) {
          results.push({
            stepName: step.toolName,
            success: true,
            result: stepResult.result
          });

          // CONSTRUIR CONTEXTO INTELIGENTE
          enhancedContext += this.buildContextFromResult(step.toolName, stepResult.result);
          
        } else {
          results.push({
            stepName: step.toolName,
            success: false,
            result: stepResult.result,
            error: stepResult.error
          });
          
          enhancedContext += `❌ Error al obtener ${step.toolName}: ${stepResult.error}\n`;
        }

      } catch (error) {
        this.logger.error(`💥 Error ejecutando step ${step.toolName}:`, error);
        results.push({
          stepName: step.toolName,
          success: false,
          result: null,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    // 3. AÑADIR INSTRUCCIONES ESPECÍFICAS AL CONTEXTO
    enhancedContext += this.buildWorkflowSpecificInstructions(matchedWorkflow, results, userMessage);

    return {
      workflowExecuted: true,
      workflowName: matchedWorkflow.name,
      results,
      enhancedContext
    };
  }

  /**
   * Encuentra el workflow más específico que coincida
   */
  private findMatchingWorkflow(userMessage: string): WorkflowDefinition | null {
    let bestMatch: WorkflowDefinition | null = null;
    let bestScore = 0;

    for (const workflow of this.workflows) {
      const score = this.calculateWorkflowScore(userMessage, workflow);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = workflow;
      }
    }

    return bestScore > 0 ? bestMatch : null;
  }

  /**
   * Calcula qué tan bien coincide un workflow con el mensaje
   */
  private calculateWorkflowScore(userMessage: string, workflow: WorkflowDefinition): number {
    let score = 0;

    for (const trigger of workflow.triggers) {
      if (userMessage.includes(trigger.toLowerCase())) {
        // Dar más puntos a coincidencias más largas y específicas
        score += trigger.length * workflow.priority;
        
        // Bonus por coincidencias exactas de frases
        if (trigger.includes(" ") && userMessage.includes(trigger)) {
          score += 50;
        }
      }
    }

    return score;
  }

  /**
   * Encuentra la integración necesaria para una herramienta
   */
  private findRequiredIntegration(toolName: string, activeIntegrations: IntegrationInfo[]): IntegrationInfo | null {
    // Mapeo de herramientas a tipos de integración
    const toolIntegrationMap: Record<string, { type: string, provider: string }> = {
      "getMyBookedCalendarEvents": { type: "calendar", provider: "google" },
      "createGoogleCalendarEvent": { type: "calendar", provider: "google" },
      "updateGoogleCalendarEvent": { type: "calendar", provider: "google" },
      "deleteGoogleCalendarEvent": { type: "calendar", provider: "google" },
      "sendWhatsAppTextMessage": { type: "messaging", provider: "whatsapp" },
      "sendWhatsAppTemplateMessage": { type: "messaging", provider: "whatsapp" }
    };

    const requiredIntegration = toolIntegrationMap[toolName];
    if (!requiredIntegration) {
      return null;
    }

    return activeIntegrations.find(integration => 
      integration.type === requiredIntegration.type && 
      integration.provider === requiredIntegration.provider
    ) || null;
  }

  /**
   * Construye contexto inteligente basado en los resultados
   */
  private buildContextFromResult(toolName: string, result: any): string {
    switch (toolName) {
      case "getMyBookedCalendarEvents":
        if (result?.events && Array.isArray(result.events)) {
          if (result.events.length === 0) {
            return "✅ **CITAS ACTUALES**: El usuario NO tiene citas programadas actualmente.\n";
          } else {
            let contextText = `✅ **CITAS ACTUALES**: El usuario tiene ${result.events.length} cita(s) programada(s):\n`;
            result.events.forEach((event: any, index: number) => {
              const startTime = event.start?.dateTime || event.start?.date;
              const summary = event.summary || 'Sin título';
              contextText += `   ${index + 1}. "${summary}" - ${startTime} (ID: ${event.id})\n`;
            });
            return contextText + "\n";
          }
        }
        return "⚠️ No se pudo obtener información de citas.\n";

      default:
        return `✅ ${toolName}: ${JSON.stringify(result).substring(0, 200)}...\n`;
    }
  }

  /**
   * Construye instrucciones específicas para el workflow
   */
  private buildWorkflowSpecificInstructions(
    workflow: WorkflowDefinition, 
    results: WorkflowResult['results'], 
    userMessage: string
  ): string {
    let instructions = "\n### 🎯 INSTRUCCIONES ESPECÍFICAS PARA ESTA CONVERSACIÓN:\n";

    
    switch (workflow.name) {
      case "appointment_management":
      case "reschedule_detection":
        const appointmentResult = results.find(r => r.stepName === "getMyBookedCalendarEvents");
        if (appointmentResult?.success) {
          const events = appointmentResult.result?.events || [];
          
          if (events.length === 0) {
            instructions += "- ✅ El usuario NO tiene citas existentes\n";
            instructions += "- 📝 Si quiere agendar una NUEVA cita, pregunta por email y nombre\n";
            instructions += "- 🔴 NUNCA uses updateGoogleCalendarEvent o deleteGoogleCalendarEvent sin citas existentes\n";
          } else {
            instructions += `- ✅ El usuario tiene ${events.length} cita(s) existente(s)\n`;
            
            if (this.isModificationIntent(userMessage)) {
              instructions += "- 🔄 INTENCIÓN DE MODIFICACIÓN detectada\n";
              instructions += "- 📋 Muestra las citas existentes y pregunta cuál quiere modificar\n";
              instructions += "- ⚡ Usa updateGoogleCalendarEvent con el eventId correcto\n";
              instructions += "- 🔴 NUNCA uses createGoogleCalendarEvent para modificaciones\n";
            } else {
              instructions += "- ⚠️ Si menciona 'cambiar', 'mover', 'reagendar' → usar updateGoogleCalendarEvent\n";
              instructions += "- ⚠️ Si menciona 'cancelar', 'eliminar' → usar deleteGoogleCalendarEvent\n";
              instructions += "- ⚠️ Para NUEVA cita adicional → usar createGoogleCalendarEvent\n";
            }
          }
        }
        break;

      case "check_my_appointments":
        const checkResult = results.find(r => r.stepName === "getMyBookedCalendarEvents");
        if (checkResult?.success) {
          const events = checkResult.result?.events || [];
          instructions += `- 📊 Mostrar las ${events.length} cita(s) encontrada(s) de forma clara y organizada\n`;
          instructions += "- 📅 Incluir fechas, horas y títulos de cada cita\n";
          instructions += "- 🔗 Mencionar que puede modificar o cancelar si lo desea\n";
        }
        break;
    }

    instructions += "\n### ⚡ REGLAS CRÍTICAS:\n";
    instructions += "- 🔒 NUNCA ignores la información obtenida automáticamente arriba\n";
    instructions += "- 🔍 La información de citas es ACTUAL y PRECISA\n";
    instructions += "- ✅ Usa esta información como base de tu respuesta\n";
    instructions += "- 🚫 NO inventes información sobre citas\n\n";

    return instructions;
  }

  /**
   * Detecta si el mensaje tiene intención de modificar algo existente
   */
  private isModificationIntent(userMessage: string): boolean {
    const modificationKeywords = [
      "cambiar", "mover", "reagendar", "modificar", "actualizar", "cancelar", "eliminar",
      "change", "move", "reschedule", "modify", "update", "cancel", "delete"
    ];
    
    const messageLower = userMessage.toLowerCase();
    return modificationKeywords.some(keyword => messageLower.includes(keyword));
  }
  
}