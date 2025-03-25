import { app } from '@azure/functions';

// Módulo de autenticación
import './functions/auth/GoogleAuth';
import './functions/auth/OtpGenerator';
import './functions/auth/OtpVerifier';
import './functions/auth/TokenRefresh';
import './functions/auth/UserLogin';
import './functions/auth/UserRegister';
import './functions/auth/UserManagement';

// Cuando implementes estos módulos, descomenta las siguientes secciones

// Módulo de agentes
// import './functions/agents/AgentCreate';
// import './functions/agents/AgentUpdate';
// import './functions/agents/AgentList';
// import './functions/agents/AgentDelete';
// import './functions/agents/AgentRoles';
// import './functions/agents/AgentStats';

// Módulo de conocimiento
import './functions/knowledge/DocumentUpload';
import './functions/knowledge/DocumentProcessor';
import './functions/knowledge/EmbeddingGenerator';
// import './functions/knowledge/DocumentSearch';
// import './functions/knowledge/KnowledgeBaseManager';
// import './functions/knowledge/DocumentManager';

// Módulo de conversación
// import './functions/conversation/MessageReceiver';
// import './functions/conversation/ContextRetriever';
// import './functions/conversation/ChatCompletion';
// import './functions/conversation/ConversationHistory';
// import './functions/conversation/FeedbackProcessor';
// import './functions/conversation/ConversationSearch';

// Módulo de handoff
// import './functions/handoff/HandoffInitiator';
// import './functions/handoff/QueueManager';
// import './functions/handoff/AgentAssignment';
// import './functions/handoff/AgentMessaging';
// import './functions/handoff/HandoffCompletion';
// import './functions/handoff/AgentStatusManager';

// Módulo de integraciones
// import './functions/integrations/IntegrationCatalog';
// import './functions/integrations/IntegrationConfig';
// import './functions/integrations/GoogleCalendar';
// import './functions/integrations/MicrosoftGraph';
// import './functions/integrations/ERPConnector';
// import './functions/integrations/IntegrationExecutor';

// Módulo de suscripciones
// import './functions/subscriptions/PlanManager';
// import './functions/subscriptions/SubscriptionManager';
// import './functions/subscriptions/PaymentProcessor';
// import './functions/subscriptions/PaymentWebhookHandler';
// import './functions/subscriptions/UsageCalculator';
// import './functions/subscriptions/InvoiceGenerator';

// Módulo de notificaciones
import './functions/notifications/EmailSender';
// import './functions/notifications/SystemNotifier';
// import './functions/notifications/AlertGenerator';

// Configuración de la aplicación
app.setup({
    enableHttpStream: true,
});