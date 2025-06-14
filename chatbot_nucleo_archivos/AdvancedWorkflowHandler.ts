// src/shared/handlers/conversation/advancedWorkflowHandler.ts

import { Logger, createLogger } from "../../utils/logger";
import { IntegrationExecutorHandler } from "../integrations/integrationExecutorHandler";
import { IntegrationAction } from "../../models/integration.model";
import { ContextResult, IntegrationInfo } from "../../models/conversation.model";
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";

// INTERFACES EXPANDIDAS
interface WorkflowStep {
  toolName: string;
  action: string;
  required: boolean;
  conditional?: string;
  parameters?: Record<string, any>;
  retryOnFailure?: boolean;
  maxRetries?: number;
}

interface WorkflowDefinition {
  name: string;
  triggers: string[];
  priority: number;
  steps: WorkflowStep[];
  description: string;
  category: 'appointments' | 'customer_service' | 'sales' | 'support';
  contextAware?: boolean;
}

interface WorkflowResult {
  workflowExecuted: boolean;
  workflowName?: string;
  category?: string;
  results: Array<{
    stepName: string;
    success: boolean;
    result: any;
    error?: string;
    retryAttempts?: number;
  }>;
  enhancedContext: string;
  executionTimeMs: number;
  userIntent: string;
}

interface UserProfile {
  isExistingClient: boolean;
  isPremiumUser: boolean;
  appointmentHistory: number;
  preferredLanguage: string;
  lastActivity: number;
}

export class AdvancedWorkflowHandler {
  private logger: Logger;
  private integrationExecutor: IntegrationExecutorHandler;
  private storageService: StorageService;

  // WORKFLOWS AVANZADOS CON LÓGICA CONDICIONAL COMPLETA
  private advancedWorkflows: WorkflowDefinition[] = [
    {
      name: "intelligent_appointment_management",
      triggers: ["cita", "agendar", "appointment", "schedule", "consulta", "reunión"],
      priority: 20,
      category: 'appointments',
      contextAware: true,
      steps: [
        {
          toolName: "getMyBookedCalendarEvents",
          action: "getMyBookedEvents",
          required: true,
          retryOnFailure: true,
          maxRetries: 2,
          parameters: {
            startDate: new Date().toISOString(),
            endDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
          }
        },
        {
          toolName: "checkUserProfile",
          action: "getUserProfile",
          required: false,
          conditional: "hasExistingAppointments"
        },
        {
          toolName: "getAvailableSlots",
          action: "getNextAvailableSlots",
          required: false,
          conditional: "isUrgentRequest",
          parameters: { timeRange: "today" }
        }
      ],
      description: "Gestión inteligente de citas con lógica contextual avanzada"
    },

    // 🔄 WORKFLOW MEJORADO DE REAGENDAMIENTO
    {
      name: "smart_reschedule_flow",
      triggers: ["cambiar", "mover", "reagendar", "modificar", "actualizar", "reschedule", "si", "sí", "yes", "ok", "okay", "dale", "perfecto", "correcto", "adelante"],
      priority: 30, // PRIORIDAD MÁS ALTA
      category: 'appointments',
      contextAware: true,
      steps: [
        {
          toolName: "getMyBookedCalendarEvents",
          action: "getMyBookedEvents",
          required: true,
          retryOnFailure: true,
          maxRetries: 3,
          parameters: {
            startDate: new Date().toISOString(),
            endDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
          }
        }
      ],
      description: "Flujo inteligente para reagendamiento con detección automática de contexto y confirmaciones"
    },

    {
      name: "vip_customer_flow",
      triggers: ["urgente", "emergency", "asap", "ahora mismo", "immediately"],
      priority: 25, // Reducida para dar prioridad al reschedule
      category: 'customer_service',
      contextAware: true,
      steps: [
        {
          toolName: "getMyBookedCalendarEvents",
          action: "getMyBookedEvents",
          required: true
        },
        {
          toolName: "checkVIPStatus",
          action: "verifyVIPStatus",
          required: false,
          conditional: "isExistingClient"
        },
        {
          toolName: "getEmergencySlots",
          action: "getEmergencyAvailability",
          required: true,
          conditional: "isUrgentRequest",
          parameters: { urgent: true, timeFrame: "today" }
        },
        {
          toolName: "notifyManager",
          action: "sendUrgentNotification",
          required: false,
          conditional: "isVIPCustomer"
        }
      ],
      description: "Flujo especial para clientes VIP y solicitudes urgentes"
    },

    {
      name: "business_hours_adaptive",
      triggers: ["disponibilidad", "horarios", "available", "hours", "abierto", "cerrado"],
      priority: 15,
      category: 'customer_service',
      contextAware: false,
      steps: [
        {
          toolName: "checkCurrentBusinessHours",
          action: "getCurrentBusinessStatus",
          required: true
        },
        {
          toolName: "getMyBookedCalendarEvents",
          action: "getMyBookedEvents",
          required: false,
          conditional: "isBusinessHours"
        },
        {
          toolName: "scheduleCallback",
          action: "scheduleCallbackForTomorrow",
          required: false,
          conditional: "isOutsideBusinessHours"
        }
      ],
      description: "Comportamiento adaptativo según horario comercial"
    },

    {
      name: "multi_service_intelligent",
      triggers: ["servicio", "servicios", "service", "services", "precio", "costo", "cost"],
      priority: 18,
      category: 'sales',
      contextAware: true,
      steps: [
        {
          toolName: "getAvailableServices",
          action: "listActiveServices",
          required: true
        },
        {
          toolName: "getMyBookedCalendarEvents",
          action: "getMyBookedEvents",
          required: true
        },
        {
          toolName: "analyzeServiceHistory",
          action: "getServicePreferences",
          required: false,
          conditional: "hasExistingAppointments"
        },
        {
          toolName: "getPersonalizedPricing",
          action: "getCustomPricing",
          required: false,
          conditional: "isPremiumUser",
          parameters: { includeDiscounts: true }
        }
      ],
      description: "Gestión inteligente de múltiples servicios con personalización"
    }
  ];

  constructor(logger?: Logger) {
    this.logger = logger || createLogger();
    this.integrationExecutor = new IntegrationExecutorHandler(this.logger);
    this.storageService = new StorageService();
  }

  /**
   * PUNTO DE ENTRADA PRINCIPAL - Detecta y ejecuta workflows avanzados
   */
  async detectAndExecuteAdvancedWorkflow(
    userMessage: string,
    context: ContextResult,
    conversationId: string,
    userId: string
  ): Promise<WorkflowResult> {
    
  const executionStart = Date.now();
  const userMessageLower = userMessage.toLowerCase().trim();
  
  // 🔥 NUEVO: DETECCIÓN TEMPRANA DE CONFIRMACIONES
  if (this.isSimpleConfirmation(userMessageLower)) {
    this.logger.info(`🔄 [Confirmation] Detectada confirmación simple: "${userMessage}"`);
    
    // Para confirmaciones, ejecutar workflow de reagendamiento directo si hay contexto
    if (this.hasRecentRescheduleContext(context)) {
      this.logger.info(`🔄 [Confirmation] Contexto de reagendamiento detectado, ejecutando smart_reschedule_flow`);
      
      const rescheduleWorkflow = this.advancedWorkflows.find(w => w.name === "smart_reschedule_flow");
      if (rescheduleWorkflow) {
        const workflowResult = await this.executeAdvancedWorkflow(
          rescheduleWorkflow,
          context,
          userMessage,
          conversationId,
          userId,
          null // No necesitamos perfil de usuario para confirmaciones
        );
        
        workflowResult.executionTimeMs = Date.now() - executionStart;
        workflowResult.userIntent = 'confirm_reschedule';
        return workflowResult;
      }
    }
    
    // Si no hay contexto de reagendamiento, no ejecutar workflow
    return {
      workflowExecuted: false,
      results: [],
      enhancedContext: "",
      executionTimeMs: Date.now() - executionStart,
      userIntent: 'simple_confirmation'
    };
  }
  
  this.logger.info(`🔍 [Advanced] Analizando mensaje: "${userMessage.substring(0, 50)}..."`);

    // 1. DETECTAR WORKFLOW MÁS ESPECÍFICO
    const matchedWorkflow = this.findBestMatchingWorkflow(userMessageLower, context);
    
    if (!matchedWorkflow) {
      return {
        workflowExecuted: false,
        results: [],
        enhancedContext: "",
        executionTimeMs: Date.now() - executionStart,
        userIntent: this.extractUserIntent(userMessage)
      };
    }

    this.logger.info(`🎯 [Advanced] Workflow seleccionado: "${matchedWorkflow.name}" (${matchedWorkflow.category})`);

    // 2. OBTENER PERFIL DE USUARIO SI ES CONTEXTUAL
    let userProfile: UserProfile | null = null;
    if (matchedWorkflow.contextAware) {
      userProfile = await this.buildUserProfile(userId, conversationId);
      this.logger.info(`👤 [Advanced] Perfil de usuario: Cliente existente=${userProfile.isExistingClient}, Premium=${userProfile.isPremiumUser}`);
    }

    // 3. EJECUTAR WORKFLOW CON LÓGICA AVANZADA
    const workflowResult = await this.executeAdvancedWorkflow(
      matchedWorkflow,
      context,
      userMessage,
      conversationId,
      userId,
      userProfile
    );

    // 4. REGISTRAR MÉTRICAS
    await this.logWorkflowExecution(matchedWorkflow.name, conversationId, workflowResult, Date.now() - executionStart);

    workflowResult.executionTimeMs = Date.now() - executionStart;
    workflowResult.userIntent = this.extractUserIntent(userMessage);

    return workflowResult;
  }

  /**
 * Detecta si es una confirmación simple que no debe buscar en KB
 */
private isSimpleConfirmation(userMessage: string): boolean {
  const confirmationPatterns = [
    /^(si|sí|yes|ok|okay|dale|perfecto|correcto|adelante)$/i,
    /^(cambiala|modificala|cancela|eliminala)$/i,
    /^(change it|modify it|cancel it|delete it|update it)$/i,
    /^(👍|👎|✅|❌)$/,
  ];
  
  return confirmationPatterns.some(pattern => pattern.test(userMessage.trim()));
}


  /**
   * EJECUTOR PRINCIPAL DEL WORKFLOW AVANZADO
   */
  private async executeAdvancedWorkflow(
    workflow: WorkflowDefinition,
    context: ContextResult,
    userMessage: string,
    conversationId: string,
    userId: string,
    userProfile: UserProfile | null
  ): Promise<WorkflowResult> {
    
    const results: WorkflowResult['results'] = [];
    let enhancedContext = `\n\n### 🤖 WORKFLOW AVANZADO: ${workflow.name} (${workflow.category})\n`;

    // INFORMACIÓN DEL PERFIL DE USUARIO
    if (userProfile) {
      enhancedContext += this.buildUserProfileContext(userProfile);
    }

    // EJECUTAR CADA STEP CON LÓGICA CONDICIONAL AVANZADA
    for (const step of workflow.steps) {
      
      // EVALUAR CONDICIÓN PREVIA
      if (step.conditional && !this.evaluateAdvancedCondition(step.conditional, results, context, userMessage, userId, userProfile)) {
        this.logger.info(`⏭️ [Advanced] Saltando step "${step.toolName}" - Condición "${step.conditional}" no cumplida`);
        continue;
      }

      // EJECUTAR STEP CON RETRY LOGIC
      const stepResult = await this.executeStepWithRetry(step, context, conversationId, userId);
      results.push(stepResult);
      
      if (stepResult.success) {
        enhancedContext += this.buildAdvancedContextFromResult(step.toolName, stepResult.result, step.conditional, userProfile);
      } else {
        enhancedContext += `❌ Error en ${step.toolName}: ${stepResult.error}\n`;
      }
    }

    // GENERAR INSTRUCCIONES DINÁMICAS CONTEXTUALES
    enhancedContext += this.generateAdvancedInstructions(workflow, results, userMessage, context, userProfile);

    return {
      workflowExecuted: true,
      workflowName: workflow.name,
      category: workflow.category,
      results,
      enhancedContext,
      executionTimeMs: 0, // Se completará en el caller
      userIntent: this.extractUserIntent(userMessage)
    };
  }

  /**
   * SISTEMA DE MATCHING INTELIGENTE DE WORKFLOWS - MEJORADO
   */
  private findBestMatchingWorkflow(userMessage: string, context: ContextResult): WorkflowDefinition | null {
    let bestMatch: WorkflowDefinition | null = null;
    let bestScore = 0;

    for (const workflow of this.advancedWorkflows) {
      let score = this.calculateAdvancedWorkflowScore(userMessage, workflow, context);
      
      // 🔄 LÓGICA ESPECIAL PARA REAGENDAMIENTO
      if (workflow.name === "smart_reschedule_flow") {
        score = this.calculateRescheduleScore(userMessage, workflow, context);
      }
      
      this.logger.debug(`🎯 Workflow "${workflow.name}": score=${score}`);
      
      if (score > bestScore) {
        bestScore = score;
        bestMatch = workflow;
      }
    }

    this.logger.info(`🏆 Mejor match: "${bestMatch?.name}" con score=${bestScore}`);
    return bestScore > 10 ? bestMatch : null; // Threshold más alto
  }

  /**
   * 🔄 NUEVO: SCORING ESPECÍFICO PARA REAGENDAMIENTO
   */
  private calculateRescheduleScore(userMessage: string, workflow: WorkflowDefinition, context: ContextResult): number {
    let score = 0;
    const messageLower = userMessage.toLowerCase().trim();

    // 1. DETECCIÓN DE REAGENDAMIENTO EXPLÍCITO
    const explicitRescheduleKeywords = ["cambiar", "mover", "reagendar", "modificar", "actualizar", "reschedule", "change", "move", "update"];
    const hasExplicitReschedule = explicitRescheduleKeywords.some(keyword => messageLower.includes(keyword));

    if (hasExplicitReschedule) {
      score += 1000; // PUNTAJE MUY ALTO para reagendamiento explícito
      this.logger.info(`🔄 [Reschedule] Reagendamiento EXPLÍCITO detectado: +1000 puntos`);
    }

    // 2. DETECCIÓN DE CONFIRMACIÓN EN CONTEXTO
    const confirmationKeywords = ["si", "sí", "yes", "ok", "okay", "dale", "perfecto", "correcto", "adelante"];
    const isShortConfirmation = messageLower.length <= 10 && confirmationKeywords.some(keyword => 
      messageLower === keyword || messageLower.includes(keyword)
    );

    if (isShortConfirmation) {
      // Verificar si hay contexto de reagendamiento en mensajes recientes
      const hasRescheduleContext = this.hasRecentRescheduleContext(context);
      
      if (hasRescheduleContext) {
        score += 800; // PUNTAJE ALTO para confirmación en contexto
        this.logger.info(`🔄 [Reschedule] Confirmación en contexto de reagendamiento detectada: +800 puntos`);
      } else {
        this.logger.debug(`🔄 [Reschedule] Confirmación detectada pero sin contexto de reagendamiento`);
      }
    }

    // 3. DETECCIÓN DE PREGUNTAS SOBRE CITAS EXISTENTES
    const appointmentQuestionKeywords = ["mis citas", "mi cita", "citas tengo", "cita tengo"];
    const hasAppointmentQuestion = appointmentQuestionKeywords.some(keyword => messageLower.includes(keyword));
    
    if (hasAppointmentQuestion) {
      score += 200; // Puntaje moderado para preguntas sobre citas
      this.logger.info(`🔄 [Reschedule] Pregunta sobre citas existentes detectada: +200 puntos`);
    }

    // 4. BONUS SCORING ORIGINAL
    for (const trigger of workflow.triggers) {
      if (messageLower.includes(trigger.toLowerCase())) {
        const baseScore = trigger.length * workflow.priority;
        score += baseScore;
        
        // BONUS por frases completas
        if (trigger.includes(" ") && messageLower.includes(trigger)) {
          score += baseScore * 0.5;
        }
        
        // BONUS por exactitud al inicio/fin de palabra
        const regex = new RegExp(`\\b${trigger}\\b`, 'i');
        if (regex.test(messageLower)) {
          score += baseScore * 0.3;
        }
      }
    }

    this.logger.debug(`🔄 [Reschedule] Score final: ${score} para mensaje: "${userMessage}"`);
    return score;
  }

  /**
   * 🔄 NUEVO: VERIFICAR SI HAY CONTEXTO RECIENTE DE REAGENDAMIENTO
   */
private hasRecentRescheduleContext(context: ContextResult): boolean {
  const recentMessages = context.conversationContext?.slice(-3) || []; // Solo últimos 3 mensajes
  
  const rescheduleIndicators = [
    'cambiar', 'mover', 'reagendar', 'modificar', 'change', 'reschedule',
    'nueva fecha', 'nuevo horario', 'another time', 'different time',
    'quieres cambiar', 'te gustaría cambiar', 'would you like to change',
    'qué día y hora', 'what day and time'
  ];

  const hasRescheduleContext = recentMessages.some(msg => {
    if (msg.role === 'assistant') {
      const content = msg.content.toLowerCase();
      return rescheduleIndicators.some(indicator => content.includes(indicator));
    }
    return false;
  });

  this.logger.debug(`🔄 [Reschedule] Contexto de reagendamiento en mensajes recientes: ${hasRescheduleContext}`);
  return hasRescheduleContext;
}

  /**
   * SCORING AVANZADO DE WORKFLOWS (ORIGINAL)
   */
  private calculateAdvancedWorkflowScore(userMessage: string, workflow: WorkflowDefinition, context: ContextResult): number {
    let score = 0;

    // 1. MATCHING DE TRIGGERS BÁSICO
    for (const trigger of workflow.triggers) {
      if (userMessage.includes(trigger.toLowerCase())) {
        const baseScore = trigger.length * workflow.priority;
        score += baseScore;
        
        // BONUS por frases completas
        if (trigger.includes(" ") && userMessage.includes(trigger)) {
          score += baseScore * 0.5;
        }
        
        // BONUS por exactitud al inicio/fin de palabra
        const regex = new RegExp(`\\b${trigger}\\b`, 'i');
        if (regex.test(userMessage)) {
          score += baseScore * 0.3;
        }
      }
    }

    // 2. BONUS POR CATEGORÍA CONTEXTUAL
    if (workflow.category === 'appointments' && this.containsAppointmentContext(userMessage)) {
      score += 20;
    }
    
    if (workflow.category === 'customer_service' && this.containsServiceContext(userMessage)) {
      score += 15;
    }

    // 3. BONUS POR URGENCIA DETECTADA
    if (workflow.name.includes('vip') && this.detectUrgency(userMessage)) {
      score += 50;
    }

    // 4. PENALIZACIÓN por workflows muy genéricos en contextos específicos
    if (workflow.name.includes('general') && this.hasSpecificContext(userMessage)) {
      score -= 10;
    }

    return score;
  }

  /**
   * GENERADOR DE CONTEXTO AVANZADO - MEJORADO PARA REAGENDAMIENTO
   */
private buildAdvancedContextFromResult(
  toolName: string, 
  result: any, 
  conditional?: string,
  userProfile?: UserProfile | null
): string {
  
  let contextText = "";
  
  switch (toolName) {
   case "getMyBookedCalendarEvents":
  if (result?.events?.length > 0) {
    const futureEvents = result.events.filter((e: any) => {
      const eventTime = new Date(e.start?.dateTime || e.start?.date);
      return eventTime > new Date();
    });
    
    contextText += `📅 **CITAS ACTIVAS**: ${futureEvents.length} cita(s) futura(s)\n`;
    
    if (futureEvents.length > 0) {
      contextText += `\n### 📋 CITAS EXISTENTES:\n`;
      
      futureEvents.forEach((event: any, index: number) => {
        const startTime = event.start?.dateTime || event.start?.date;
        const formattedDate = new Date(startTime).toLocaleString('es-MX', {
          weekday: 'long',
          year: 'numeric',
          month: 'long', 
          day: 'numeric',
          hour: event.start?.dateTime ? 'numeric' : undefined,
          minute: event.start?.dateTime ? '2-digit' : undefined,
          timeZone: 'America/Mexico_City'
        });

        contextText += `${index + 1}. **"${event.summary || 'Cita sin título'}"**\n`;
        contextText += `   - 🕐 Fecha/Hora: ${formattedDate}\n`;
        
        // 🔥 HACER EL EVENT ID IMPOSIBLE DE IGNORAR
        contextText += `   - 🔑 **CRITICAL_EVENT_ID_FOR_UPDATE**: "${event.id}"\n`;
        contextText += `   - 🚨 **USE_THIS_EXACT_ID**: "${event.id}"\n`;
        
        if (event.location) {
          contextText += `   - 📍 Ubicación: ${event.location}\n`;
        }
        contextText += `\n`;
      });
      
      // 🔥 AÑADIR SECCIÓN SUPER VISIBLE
      if (futureEvents.length === 1) {
        const eventId = futureEvents[0].id;
        contextText += `\n🚨🚨🚨 CRITICAL INSTRUCTION 🚨🚨🚨\n`;
        contextText += `IF USER WANTS TO UPDATE/DELETE THIS APPOINTMENT:\n`;
        contextText += `COPY THIS EXACT eventId: "${eventId}"\n`;
        contextText += `DO NOT USE: "10", "1", "event-id", or any other value\n`;
        contextText += `ONLY USE: "${eventId}"\n`;
        contextText += `🚨🚨🚨 END CRITICAL INSTRUCTION 🚨🚨🚨\n\n`;
      }
    }
  } else {
    contextText += `🆕 **CLIENTE NUEVO**: Sin historial de citas\n`;
  }
  break;
      
    // ... resto de casos igual
  }
  
  return contextText;
}

// 🔥 NUEVO MÉTODO: Generar información precisa de fecha
private generatePreciseDateInfo(date: Date): { fullDate: string, dayName: string, time: string } {
  const dayNames = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const months = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  
  const dayName = dayNames[date.getDay()];
  const day = date.getDate();
  const month = months[date.getMonth()];
  const year = date.getFullYear();
  
  const fullDate = `${day} de ${month} de ${year}`;
  
  const time = date.toLocaleTimeString('es-MX', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Mexico_City'
  });
  
  return {
    fullDate,
    dayName,
    time
  };
}

  /**
   * GENERADOR DE INSTRUCCIONES AVANZADAS - MEJORADO PARA REAGENDAMIENTO
   */
  private generateAdvancedInstructions(
    workflow: WorkflowDefinition,
    results: any[],
    userMessage: string,
    context: ContextResult,
    userProfile: UserProfile | null
  ): string {
    
    let instructions = "\n### 🎯 INSTRUCCIONES CONTEXTUALES AVANZADAS:\n";
    
    // INSTRUCCIONES BASADAS EN PERFIL DE USUARIO
    if (userProfile) {
      if (userProfile.isPremiumUser) {
        instructions += "- 💎 **CLIENTE VIP**: Ofrecer servicios premium y atención prioritaria\n";
        instructions += "- 📞 **CONTACTO DIRECTO**: Proporcionar líneas VIP y WhatsApp directo\n";
      }
      
      if (userProfile.isExistingClient) {
        instructions += "- 🎖️ **CLIENTE LEAL**: Agradecer fidelidad y ofrecer beneficios\n";
        instructions += "- 📊 **PERSONALIZACIÓN**: Usar historial para recomendaciones\n";
      } else {
        instructions += "- 🆕 **CLIENTE NUEVO**: Explicar proceso completo y ventajas\n";
        instructions += "- 📚 **EDUCACIÓN**: Introducir servicios y políticas gradualmente\n";
      }
    }
    
    // 🔄 INSTRUCCIONES ESPECÍFICAS PARA REAGENDAMIENTO
    if (workflow.name === "smart_reschedule_flow") {
      instructions += this.generateRescheduleInstructions(results, userMessage, context);
    }
    
    // INSTRUCCIONES BASADAS EN CATEGORÍA DE WORKFLOW
    switch (workflow.category) {
      case 'appointments':
        const hasAppointments = results.some(r => 
          r.stepName === "getMyBookedCalendarEvents" && 
          r.success && 
          r.result?.events?.length > 0
        );
        
        if (hasAppointments) {
          instructions += "- 🔄 **GESTIÓN EXISTENTE**: Priorizar modificación sobre creación nueva\n";
          instructions += "- ⚡ **HERRAMIENTAS**: Usar updateGoogleCalendarEvent para cambios\n";
        } else {
          instructions += "- 📝 **NUEVA CITA**: Recopilar email y nombre obligatoriamente\n";
          instructions += "- ✅ **HERRAMIENTAS**: Usar createGoogleCalendarEvent para crear\n";
        }
        break;
        
      case 'customer_service':
        if (this.detectUrgency(userMessage)) {
          instructions += "- 🚨 **URGENCIA**: Priorizar resolución rápida y escalación si necesario\n";
          instructions += "- ⚡ **TIEMPO**: Responder con slots del mismo día si posible\n";
        }
        break;
        
      case 'sales':
        instructions += "- 💰 **OPORTUNIDAD**: Mencionar promociones y paquetes disponibles\n";
        instructions += "- 🎯 **CONVERSIÓN**: Guiar hacia agendamiento después de información\n";
        break;
    }
    
    // INSTRUCCIONES BASADAS EN HORARIO
    if (!this.checkBusinessHours()) {
      instructions += "- 🌙 **FUERA DE HORARIO**: Ofrecer callback y agenda para mañana\n";
      instructions += "- 📧 **ALTERNATIVAS**: Recopilar email para seguimiento temprano\n";
    }
    
    // INSTRUCCIONES BASADAS EN RESULTADOS DE WORKFLOW
    const emergencySlots = results.find(r => r.stepName === "getEmergencySlots");
    if (emergencySlots?.success && emergencySlots.result?.slots?.length > 0) {
      instructions += "- 🚨 **SLOTS URGENTES**: Presentar opciones inmediatas disponibles\n";
    }
    
    instructions += "\n### ⚡ REGLAS CRÍTICAS AVANZADAS:\n";
    instructions += "- 🔒 Toda la información arriba es ACTUAL y debe usarse como base\n";
    instructions += "- 🧠 Personalizar respuesta según perfil y contexto detectado\n";
    instructions += "- 🎯 Adaptar tono y opciones según categoría de workflow\n";
    instructions += "- 🚫 NUNCA contradecir la información contextual obtenida\n\n";
    
    return instructions;
  }

  /**
   * 🔄 NUEVO: GENERADOR DE INSTRUCCIONES ESPECÍFICAS PARA REAGENDAMIENTO
   */
private generateRescheduleInstructions(
  results: any[],
  userMessage: string,
  context: ContextResult
): string {
  let instructions = "\n### 🔄 INSTRUCCIONES ESPECÍFICAS DE REAGENDAMIENTO:\n\n";

  const appointmentResult = results.find(r => r.stepName === "getMyBookedCalendarEvents");
  
  if (!appointmentResult?.success) {
    instructions += `❌ **ERROR TÉCNICO**: No se pudieron obtener las citas existentes\n`;
    instructions += `- Informa al usuario que hubo un problema técnico\n`;
    instructions += `- NO intentes usar herramientas de calendario manualmente\n`;
    instructions += `- Sugiere intentar más tarde\n\n`;
    return instructions;
  }

  const existingEvents = appointmentResult.result?.events || [];
  const activeEvents = existingEvents.filter((event: any) => {
    const eventEndTime = event.end?.dateTime || event.end?.date;
    return eventEndTime && (new Date(eventEndTime) > new Date());
  });

  if (activeEvents.length === 0) {
    instructions += `ℹ️ **SIN CITAS ACTIVAS**: El usuario NO tiene citas para reagendar\n`;
    instructions += `**ACCIONES REQUERIDAS:**\n`;
    instructions += `- Informa claramente: "No tienes citas programadas para modificar"\n`;
    instructions += `- Pregunta si quiere agendar una NUEVA cita\n`;
    instructions += `- NO uses updateGoogleCalendarEvent o deleteGoogleCalendarEvent\n`;
    instructions += `- Si quiere nueva cita: pide email y nombre, usa createGoogleCalendarEvent\n\n`;
    return instructions;
  }

  // CASO: TIENE CITAS ACTIVAS
  instructions += `✅ **CITAS ACTIVAS ENCONTRADAS**: ${activeEvents.length} cita(s) disponible(s) para reagendar\n\n`;

  if (activeEvents.length === 1) {
    const singleEvent = activeEvents[0];
    const startTime = singleEvent.start?.dateTime || singleEvent.start?.date;
    const eventDate = new Date(startTime);
    
    // 🔥 GENERAR INFORMACIÓN PRECISA
    const preciseDateInfo = this.generatePreciseDateInfo(eventDate);
    
    instructions += `**CASO: UNA SOLA CITA ACTIVA**\n`;
    instructions += `- **Cita actual**: "${singleEvent.summary || 'Sin título'}"\n`;
    instructions += `- **Fecha exacta**: ${preciseDateInfo.fullDate}\n`;
    instructions += `- **Día de la semana**: ${preciseDateInfo.dayName}\n`;
    instructions += `- **Hora**: ${preciseDateInfo.time}\n`;
    instructions += `- **Event ID**: \`${singleEvent.id}\`\n\n`;
    
    // 🔥 AÑADIDO: INSTRUCCIONES CRÍTICAS PARA EVENT ID
    instructions += `### 🚨 CRÍTICO - EVENT ID PARA updateGoogleCalendarEvent:\n`;
    instructions += `**DEBES USAR EXACTAMENTE ESTE EVENT ID:**\n`;
    instructions += `\`\`\`\n`;
    instructions += `"${singleEvent.id}"\n`;
    instructions += `\`\`\`\n`;
    instructions += `❌ NUNCA uses: "10", "1", "existing-event-id", o cualquier otro ID\n`;
    instructions += `✅ SIEMPRE copia y pega: "${singleEvent.id}"\n\n`;
    
    // 🔥 INSTRUCCIONES CRÍTICAS DE COMUNICACIÓN
    instructions += `**PROTOCOLO DE COMUNICACIÓN OBLIGATORIO:**\n`;
    instructions += `1. 📢 **AL INFORMAR LA CITA EXISTENTE:**\n`;
    instructions += `   - Di: "Tienes una cita el ${preciseDateInfo.dayName} ${preciseDateInfo.fullDate} a las ${preciseDateInfo.time}"\n`;
    instructions += `   - ❌ NUNCA digas: "el [día solicitado] [fecha encontrada]"\n`;
    instructions += `   - ✅ SIEMPRE usa: "el [día real] [fecha real]"\n\n`;
    
    instructions += `2. 🔄 **SI HAY DISCREPANCIA DE DÍAS:**\n`;
    instructions += `   - Si usuario pidió "lunes" pero cita es martes, di:\n`;
    instructions += `   - "Veo que pediste para lunes, pero tu cita existente es el ${preciseDateInfo.dayName} ${preciseDateInfo.fullDate}"\n`;
    instructions += `   - Luego pregunta si quiere cambiarla o mantenerla\n\n`;
    
    instructions += `**FLUJO OBLIGATORIO:**\n`;
    instructions += `1. Si el usuario ya especificó nueva fecha/hora:\n`;
    instructions += `   - Valida que cumple reglas (24h+ anticipación, Lu-Vie 9AM-6PM)\n`;
    instructions += `   - 🔑 Usa updateGoogleCalendarEvent con eventId: "${singleEvent.id}"\n`;
    instructions += `   - ⚠️ COPIA EXACTAMENTE el eventId de arriba, no lo cambies\n`;
    instructions += `   - NUNCA uses createGoogleCalendarEvent para reagendamiento\n\n`;
    
    instructions += `2. Si NO especificó nueva fecha/hora:\n`;
    instructions += `   - Pregunta: "¿Para qué día y hora te gustaría cambiar tu cita?"\n`;
    instructions += `   - Espera respuesta y luego procede con updateGoogleCalendarEvent\n\n`;
    
  } else {
    instructions += `**CASO: MÚLTIPLES CITAS ACTIVAS**\n`;
    instructions += `- El usuario tiene ${activeEvents.length} citas que puede reagendar\n`;
    instructions += `- DEBES preguntarle cuál específicamente quiere cambiar\n\n`;
    
    instructions += `**PROTOCOLO PARA LISTAR CITAS:**\n`;
    activeEvents.forEach((event: any, index: number) => {
      const startTime = event.start?.dateTime || event.start?.date;
      const eventDate = new Date(startTime);
      const preciseDateInfo = this.generatePreciseDateInfo(eventDate);
      
      instructions += `${index + 1}. "${event.summary || 'Sin título'}" - ${preciseDateInfo.dayName} ${preciseDateInfo.fullDate} a las ${preciseDateInfo.time}\n`;
    });
    
    instructions += `\n**FLUJO OBLIGATORIO:**\n`;
    instructions += `1. Pregunta: "¿Cuál de estas citas quieres reagendar?"\n`;
    instructions += `2. Una vez que elija, pregunta nueva fecha/hora\n`;
    instructions += `3. Usa updateGoogleCalendarEvent con el Event ID correcto\n\n`;
    
    // 🔥 AÑADIDO: IDs REALES PARA MÚLTIPLES CITAS
    instructions += `### 🔑 IDs REALES DISPONIBLES:\n`;
    activeEvents.forEach((event: any, index: number) => {
      instructions += `${index + 1}. "${event.summary || 'Sin título'}" → Event ID: "${event.id}"\n`;
    });
    instructions += `\n⚠️ USA EXACTAMENTE uno de estos IDs, NO inventes otros\n\n`;
  }

  // DETECCIÓN DEL CONTEXTO ACTUAL
  const messageLower = userMessage.toLowerCase().trim();
  const isConfirmation = ["si", "sí", "yes", "ok", "okay", "dale", "perfecto", "correcto", "adelante"].includes(messageLower);
  
  if (isConfirmation) {
    instructions += `**CONTEXTO ACTUAL: CONFIRMACIÓN DETECTADA**\n`;
    instructions += `- El usuario dijo: "${userMessage}"\n`;
    instructions += `- Esto parece ser una confirmación\n`;
    instructions += `- Revisa el contexto de conversación para entender QUÉ está confirmando\n`;
    instructions += `- Si confirma reagendamiento: procede con updateGoogleCalendarEvent\n\n`;
  }

  instructions += `### ⚠️ REGLAS ABSOLUTAS PARA REAGENDAMIENTO:\n`;
  instructions += `- ✅ SIEMPRE usar Event IDs reales de la lista de arriba\n`;
  instructions += `- ❌ NUNCA inventar IDs como "existing-event-id"\n`;
  instructions += `- ✅ COMUNICAR fechas exactas como aparecen arriba\n`;
  instructions += `- ❌ NO mezclar día solicitado con fecha encontrada\n`;
  instructions += `- ✅ VALIDAR nuevas fechas/horas antes de updateGoogleCalendarEvent\n`;
  instructions += `- ❌ NO usar createGoogleCalendarEvent para reagendamiento\n`;
  instructions += `- ✅ Confirmar cambio exitoso al usuario\n`;
  instructions += `- ❌ NO preguntar por email/nombre en reagendamientos\n\n`;

  // 🔥 AÑADIDO: VERIFICACIÓN FINAL
  if (activeEvents.length === 1) {
    instructions += `### 🔒 VERIFICACIÓN FINAL ANTES DE LLAMAR updateGoogleCalendarEvent:\n`;
    instructions += `1. ¿El eventId que vas a usar es: "${activeEvents[0].id}"? ✅\n`;
    instructions += `2. ¿NO es un número simple como "10"? ✅\n`;
    instructions += `3. ¿Tiene más de 15 caracteres? ✅\n`;
    instructions += `**Si alguna respuesta es NO → DETENTE y pregunta al usuario**\n\n`;
  }

  return instructions;
}

  // RESTO DE MÉTODOS ORIGINALES (sin cambios, incluyo algunos clave)

  /**
   * CONSTRUCTOR DE PERFIL DE USUARIO
   */
  private async buildUserProfile(userId: string, conversationId: string): Promise<UserProfile> {
    try {
      // DATOS DE CITAS PREVIAS
      const appointmentHistory = await this.getAppointmentHistory(userId);
      
      // DATOS DE LA CONVERSACIÓN ACTUAL
      const conversationData = await this.getConversationHistory(conversationId);
      
      // VERIFICAR STATUS PREMIUM
      const isPremium = await this.checkPremiumStatus(userId);
      
      return {
        isExistingClient: appointmentHistory > 0,
        isPremiumUser: isPremium,
        appointmentHistory,
        preferredLanguage: this.detectLanguagePreference(conversationData),
        lastActivity: Date.now()
      };
      
    } catch (error) {
      this.logger.error(`Error construyendo perfil de usuario:`, error);
      return {
        isExistingClient: false,
        isPremiumUser: false,
        appointmentHistory: 0,
        preferredLanguage: 'es',
        lastActivity: Date.now()
      };
    }
  }

  /**
   * EVALUADOR DE CONDICIONES AVANZADAS
   */
  private evaluateAdvancedCondition(
    condition: string,
    previousResults: any[],
    context: ContextResult,
    userMessage: string,
    userId: string,
    userProfile: UserProfile | null
  ): boolean {
    
    switch (condition) {
      case "hasExistingAppointments":
        const appointmentResult = previousResults.find(r => r.stepName === "getMyBookedCalendarEvents");
        return appointmentResult?.success && appointmentResult.result?.events?.length > 0;
      
      case "isPremiumUser":
        return userProfile?.isPremiumUser === true;
      
      case "isExistingClient":
        return userProfile?.isExistingClient === true;
      
      case "isBusinessHours":
        return this.checkBusinessHours();
      
      case "isOutsideBusinessHours":
        return !this.checkBusinessHours();
      
      case "isUrgentRequest":
        return this.detectUrgency(userMessage);
      
      case "isVIPCustomer":
        return userProfile?.isPremiumUser === true && (userProfile?.appointmentHistory || 0) > 5;
      
      case "isWeekend":
        const dayOfWeek = new Date().getDay();
        return dayOfWeek === 0 || dayOfWeek === 6;
      
      case "isFirstTimeUser":
        return userProfile?.appointmentHistory === 0;
      
      case "hasRecentActivity":
        const hoursSinceLastActivity = userProfile?.lastActivity 
          ? (Date.now() - userProfile.lastActivity) / (1000 * 60 * 60)
          : Infinity;
        return hoursSinceLastActivity < 24;
      
      default:
        this.logger.warn(`⚠️ Condición desconocida: ${condition}`);
        return false;
    }
  }

  /**
   * EJECUTOR DE STEP CON RETRY LOGIC
   */
  private async executeStepWithRetry(
    step: WorkflowStep,
    context: ContextResult,
    conversationId: string,
    userId: string
  ): Promise<any> {
    
    const maxRetries = step.retryOnFailure ? (step.maxRetries || 1) : 0;
    let lastError: string | undefined;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          this.logger.info(`🔄 Retry ${attempt}/${maxRetries} para step: ${step.toolName}`);
          await this.delay(1000 * attempt); // Backoff exponencial básico
        }
        
        const result = await this.executeStep(step, context, conversationId, userId);
        
        if (result.success) {
          return {
            ...result,
            retryAttempts: attempt
          };
        } else {
          lastError = result.error;
          if (!step.retryOnFailure) break;
        }
        
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        this.logger.error(`💥 Error en step ${step.toolName} (intento ${attempt + 1}):`, error);
        
        if (!step.retryOnFailure) break;
      }
    }

    return {
      stepName: step.toolName,
      success: false,
      result: null,
      error: lastError || 'Error desconocido',
      retryAttempts: maxRetries
    };
  }

  // MÉTODOS AUXILIARES IMPLEMENTADOS

  private buildUserProfileContext(userProfile: UserProfile): string {
    let context = "### 👤 PERFIL DE USUARIO:\n";
    
    if (userProfile.isExistingClient) {
      context += `- ✅ **CLIENTE EXISTENTE**: ${userProfile.appointmentHistory} cita(s) previa(s)\n`;
    } else {
      context += "- 🆕 **CLIENTE NUEVO**: Primera interacción\n";
    }
    
    if (userProfile.isPremiumUser) {
      context += "- 💎 **USUARIO PREMIUM**: Acceso a servicios VIP\n";
    }
    
    context += `- 🌐 **IDIOMA**: ${userProfile.preferredLanguage}\n\n`;
    
    return context;
  }

  private extractUserIntent(userMessage: string): string {
    const messageLower = userMessage.toLowerCase();
    
    if (messageLower.includes('agendar') || messageLower.includes('cita')) return 'schedule_appointment';
    if (messageLower.includes('cambiar') || messageLower.includes('mover')) return 'reschedule_appointment';
    if (messageLower.includes('cancelar') || messageLower.includes('eliminar')) return 'cancel_appointment';
    if (messageLower.includes('precio') || messageLower.includes('costo')) return 'inquiry_pricing';
    if (messageLower.includes('servicio') || messageLower.includes('disponible')) return 'inquiry_services';
    if (messageLower.includes('urgente') || messageLower.includes('emergency')) return 'urgent_request';
    
    return 'general_inquiry';
  }

  private containsAppointmentContext(message: string): boolean {
    const appointmentTerms = ['cita', 'appointment', 'agendar', 'schedule', 'consulta', 'reunión'];
    return appointmentTerms.some(term => message.includes(term));
  }

  private containsServiceContext(message: string): boolean {
    const serviceTerms = ['servicio', 'service', 'ayuda', 'help', 'información', 'information'];
    return serviceTerms.some(term => message.includes(term));
  }

  private detectUrgency(message: string): boolean {
    const urgentTerms = ['urgente', 'emergency', 'asap', 'ahora', 'immediately', 'ya'];
    return urgentTerms.some(term => message.toLowerCase().includes(term));
  }

  private hasSpecificContext(message: string): boolean {
    return this.containsAppointmentContext(message) || 
           this.containsServiceContext(message) || 
           this.detectUrgency(message);
  }

  private checkBusinessHours(): boolean {
    const now = new Date();
    const hour = now.getHours();
    const day = now.getDay();
    
    // Lunes a Viernes 9 AM - 6 PM
    return day >= 1 && day <= 5 && hour >= 9 && hour < 18;
  }

  private async executeStep(step: WorkflowStep, context: ContextResult, conversationId: string, userId: string): Promise<any> {
    const integration = this.findRequiredIntegration(step.toolName, context.activeIntegrations || []);
    if (!integration) {
      throw new Error(`Integración no disponible: ${step.toolName}`);
    }
    
    const actionRequest: IntegrationAction = {
      integrationId: integration.id,
      action: step.action,
      parameters: step.parameters || {},
      userId: userId,
      conversationId: conversationId,
      messageId: `advanced-workflow-${Date.now()}`,
      async: false
    };
    
    const result = await this.integrationExecutor.execute(actionRequest, userId);
    
    return {
      stepName: step.toolName,
      success: result.success,
      result: result.result,
      error: result.error
    };
  }

  private findRequiredIntegration(toolName: string, activeIntegrations: IntegrationInfo[]): IntegrationInfo | null {
    const toolIntegrationMap: Record<string, { type: string, provider: string }> = {
      "getMyBookedCalendarEvents": { type: "calendar", provider: "google" },
      "createGoogleCalendarEvent": { type: "calendar", provider: "google" },
      "updateGoogleCalendarEvent": { type: "calendar", provider: "google" },
      "deleteGoogleCalendarEvent": { type: "calendar", provider: "google" },
      "checkCurrentBusinessHours": { type: "calendar", provider: "google" },
      "getAvailableServices": { type: "calendar", provider: "google" },
      "sendWhatsAppTextMessage": { type: "messaging", provider: "whatsapp" }
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

  private async getAppointmentHistory(userId: string): Promise<number> {
    try {
      const messagesTable = this.storageService.getTableClient(STORAGE_TABLES.MESSAGES);
      let appointmentCount = 0;
      
      const messages = messagesTable.listEntities({
        queryOptions: { 
          filter: `senderId eq '${userId}' and messageType eq 'text'`
        }
      });
      
      for await (const message of messages) {
        const content = (message.content as string || '').toLowerCase();
        if (content.includes('cita') || content.includes('appointment')) {
          appointmentCount++;
        }
      }
      
      return appointmentCount;
    } catch (error) {
      this.logger.error('Error obteniendo historial de citas:', error);
      return 0;
    }
  }

  private async getConversationHistory(conversationId: string): Promise<any[]> {
    try {
      const messagesTable = this.storageService.getTableClient(STORAGE_TABLES.MESSAGES);
      const messages: any[] = [];
      
      const entities = messagesTable.listEntities({
        queryOptions: { 
          filter: `PartitionKey eq '${conversationId}'`
        }
      });
      
      for await (const message of entities) {
        messages.push(message);
      }
      
      return messages.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
    } catch (error) {
      this.logger.error('Error obteniendo historial de conversación:', error);
      return [];
    }
  }

  private async checkPremiumStatus(userId: string): Promise<boolean> {
    try {
      // TODO: Implementar lógica real para verificar status premium
      // Por ahora, asumimos que usuarios con muchas citas son premium
      const appointmentHistory = await this.getAppointmentHistory(userId);
      return appointmentHistory > 5;
    } catch (error) {
      this.logger.error('Error verificando status premium:', error);
      return false;
    }
  }

  private detectLanguagePreference(conversationData: any[]): string {
    // Análisis simple de idioma basado en contenido
    const spanishKeywords = ['que', 'como', 'cuando', 'donde', 'cita', 'hola'];
    const englishKeywords = ['what', 'how', 'when', 'where', 'appointment', 'hello'];
    
    let spanishScore = 0;
    let englishScore = 0;
    
    conversationData.forEach(message => {
      const content = (message.content || '').toLowerCase();
      spanishKeywords.forEach(keyword => {
        if (content.includes(keyword)) spanishScore++;
      });
      englishKeywords.forEach(keyword => {
        if (content.includes(keyword)) englishScore++;
      });
    });
    
    return spanishScore >= englishScore ? 'es' : 'en';
  }

  private async delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async logWorkflowExecution(
    workflowName: string, 
    conversationId: string, 
    result: WorkflowResult, 
    executionTimeMs: number
  ): Promise<void> {
    try {
      const logsTable = this.storageService.getTableClient(STORAGE_TABLES.WORKFLOW_LOGS);
      
      const logEntry = {
        partitionKey: `workflow-${workflowName}`,
        rowKey: `${Date.now()}-${conversationId}`,
        workflowName,
        conversationId,
        category: result.category,
        userIntent: result.userIntent,
        executionTimeMs,
        successfulSteps: result.results.filter(r => r.success).length,
        totalSteps: result.results.length,
        successRate: result.results.length > 0 ? result.results.filter(r => r.success).length / result.results.length : 0,
        timestamp: Date.now()
      };
      
      await logsTable.createEntity(logEntry);
      this.logger.info(`📊 Workflow "${workflowName}" registrado: ${logEntry.successfulSteps}/${logEntry.totalSteps} steps exitosos`);
    } catch (error) {
      this.logger.error('Error registrando ejecución de workflow:', error);
    }
  }
}