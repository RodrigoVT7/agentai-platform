import { app } from '@azure/functions';

// Módulo de autenticación
import './functions/auth/GoogleAuth';
import './functions/auth/OtpGenerator';
import './functions/auth/OtpVerifier';
import './functions/auth/TokenRefresh';
import './functions/auth/UserLogin';
import './functions/auth/UserRegister';
import './functions/auth/UserManagement';

// Módulo de agentes
import './functions/agents/AgentCreate';
import './functions/agents/AgentUpdate';
import './functions/agents/AgentList';
import './functions/agents/AgentDelete';
import './functions/agents/AgentRoles';
import './functions/agents/AgentStats';
import './functions/agents/AgentDetails';

// Módulo de conocimiento
import './functions/knowledge/DocumentUpload';
import './functions/knowledge/DocumentProcessor';
import './functions/knowledge/EmbeddingGenerator';
import './functions/knowledge/DocumentSearch';
import './functions/knowledge/KnowledgeBaseManager';
import './functions/knowledge/DocumentManager';

// Módulo de conversación
import './functions/conversation/MessageReceiver';
import './functions/conversation/ContextRetriever';
import './functions/conversation/ChatCompletion';
import './functions/conversation/ConversationHistory';
import './functions/conversation/FeedbackProcessor';
import './functions/conversation/ConversationSearch';

// Módulo de notificaciones
import './functions/notifications/EmailSender';

// Módulo de playground
import './functions/playground/PlaygroundSession';

// Configuración de la aplicación
app.setup({
  enableHttpStream: true,
});