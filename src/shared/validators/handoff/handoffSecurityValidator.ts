// // src/shared/validators/handoff/handoffSecurityValidator.ts
// import { ValidationResult } from "../../models/validation.model";
// import { StorageService } from "../../services/storage.service";
// import { STORAGE_TABLES } from "../../constants";
// import { Logger, createLogger } from "../../utils/logger";
// import { HandoffStatus, AgentStatus } from "../../models/handoff.model";

// export class HandoffSecurityValidator {
//     private storageService: StorageService;
//     private logger: Logger;

//     constructor(logger?: Logger) {
//         this.storageService = new StorageService();
//         this.logger = logger || createLogger();
//     }

//     /**
//      * Valida si un agente humano puede realizar operaciones de handoff
//      */
//     async validateAgentPermissions(agentUserId: string, operation: 'view' | 'assign' | 'message' | 'complete'): Promise<ValidationResult> {
//         const errors: string[] = [];

//         try {
//             // Verificar si el usuario existe
//             const usersTable = this.storageService.getTableClient(STORAGE_TABLES.USERS);
//             try {
//                 const user = await usersTable.getEntity('user', agentUserId);
//                 if (!user.isActive) {
//                     errors.push("La cuenta del agente está desactivada.");
//                 }
//             } catch (error: any) {
//                 if (error.statusCode === 404) {
//                     errors.push("Agente no encontrado en el sistema.");
//                 } else {
//                     throw error;
//                 }
//             }

//             // Verificar roles del usuario para operaciones de handoff
//             const rolesTable = this.storageService.getTableClient(STORAGE_TABLES.USER_ROLES);
//             let hasValidRole = false;
            
//             const roles = rolesTable.listEntities({
//                 queryOptions: { filter: `userId eq '${agentUserId}' and isActive eq true` }
//             });

//             for await (const role of roles) {
//                 if (role.roleType === 'AGENT' || role.roleType === 'ADMIN') {
//                     hasValidRole = true;
//                     break;
//                 }
//             }

//             if (!hasValidRole) {
//                 errors.push("El usuario no tiene permisos para realizar operaciones de handoff.");
//             }

//             // Validaciones específicas por operación
//             if (operation === 'assign' || operation === 'message' || operation === 'complete') {
//                 // Verificar estado del agente
//                 const agentStatusTable = this.storageService.getTableClient(STORAGE_TABLES.AGENT_STATUS);
//                 try {
//                     const statusEntity = await agentStatusTable.getEntity(agentUserId, 'current');
//                     const agentStatus = statusEntity.status as AgentStatus;
                    
//                     if (operation === 'assign' && agentStatus !== AgentStatus.ONLINE && agentStatus !== AgentStatus.AVAILABLE) {
//                         errors.push(`No puedes tomar conversaciones porque tu estado es ${agentStatus}. Cambia tu estado a disponible.`);
//                     }
//                 } catch (error: any) {
//                     if (error.statusCode === 404) {
//                         errors.push("Debes establecer tu estado de disponibilidad antes de realizar operaciones de handoff.");
//                     } else {
//                         throw error;
//                     }
//                 }
//             }

//         } catch (error) {
//             this.logger.error(`Error verificando permisos de admin para ${userId}:`, error);
//             return false;
//         }
//     }

//     private async getCurrentHandoffCount(agentUserId: string): Promise<number> {
//         try {
//             const handoffTable = this.storageService.getTableClient(STORAGE_TABLES.HANDOFFS);
//             let count = 0;

//             const activeHandoffs = handoffTable.listEntities({
//                 queryOptions: { 
//                     filter: `assignedAgentId eq '${agentUserId}' and status eq '${HandoffStatus.ACTIVE}' and isActive eq true` 
//                 }
//             });

//             for await (const handoff of activeHandoffs) {
//                 count++;
//             }

//             return count;
//         } catch (error) {
//             this.logger.error(`Error contando handoffs activos para ${agentUserId}:`, error);
//             return 0;
//         }
//     }

//     private async getRecentOperations(agentUserId: string, operation: string, sinceTimestamp: number): Promise<number> {
//         try {
//             // Usar tabla de logs de actividad si existe, o tabla relevante según la operación
//             let table;
//             let filter;

//             switch (operation) {
//                 case 'assign':
//                     table = this.storageService.getTableClient(STORAGE_TABLES.HANDOFFS);
//                     filter = `assignedAgentId eq '${agentUserId}' and assignedAt ge ${sinceTimestamp}L`;
//                     break;
//                 case 'message':
//                     table = this.storageService.getTableClient(STORAGE_TABLES.MESSAGES);
//                     filter = `senderId eq '${agentUserId}' and role eq 'human_agent' and createdAt ge ${sinceTimestamp}L`;
//                     break;
//                 case 'complete':
//                     table = this.storageService.getTableClient(STORAGE_TABLES.HANDOFFS);
//                     filter = `completedBy eq '${agentUserId}' and completedAt ge ${sinceTimestamp}L`;
//                     break;
//                 default:
//                     return 0;
//             }

//             let count = 0;
//             const entities = table.listEntities({ queryOptions: { filter } });

//             for await (const entity of entities) {
//                 count++;
//             }

//             return count;
//         } catch (error) {
//             this.logger.error(`Error contando operaciones recientes ${operation} para ${agentUserId}:`, error);
//             return 0;
//         }
//     }
// }