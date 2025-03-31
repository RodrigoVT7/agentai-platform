// src/shared/handlers/agents/agentRolesHandler.ts
import { v4 as uuidv4 } from "uuid";
import { StorageService } from "../../services/storage.service";
import { NotificationService } from "../../services/notification.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { UserRole, RoleType, InvitationStatus } from "../../models/userRole.model";

export class AgentRolesHandler {
  private storageService: StorageService;
  private notificationService: NotificationService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.notificationService = new NotificationService();
    this.logger = logger || createLogger();
  }
  
  async listRoles(agentId: string, userId: string): Promise<any> {
    try {
      // Verificar si el usuario tiene acceso al agente
      await this.verifyAgentAccess(agentId, userId);
      
      // Obtener todos los roles asociados al agente
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.USER_ROLES);
      const roles: UserRole[] = [];
      
      const rolesEntities = tableClient.listEntities({
        queryOptions: { filter: `agentId eq '${agentId}'` }
      });
      
      for await (const role of rolesEntities) {
        roles.push({
          id: role.id as string,
          agentId: role.agentId as string,
          userId: role.userId as string,
          role: role.role as RoleType,
          invitedBy: role.invitedBy as string,
          email: role.email as string,
          status: role.status as InvitationStatus,
          createdAt: role.createdAt as number,
          updatedAt: role.updatedAt as number,
          isActive: role.isActive as boolean
        });
      }
      
      // Obtener información adicional de los usuarios
      const enrichedRoles = await this.enrichRolesWithUserInfo(roles);
      
      return {
        agentId,
        roles: enrichedRoles
      };
    } catch (error: unknown) {
      this.logger.error(`Error al listar roles para el agente ${agentId}:`, error);
      
      if (error && typeof error === 'object' && 'statusCode' in error) {
        throw error;
      }
      
      throw createAppError(500, 'Error al listar roles');
    }
  }
  
  async assignRole(agentId: string, userId: string, roleData: any): Promise<any> {
    try {
      // Verificar si el usuario tiene permisos para asignar roles (debe ser propietario o admin)
      await this.verifyRolePermission(agentId, userId);
      
      const { targetEmail, role } = roleData;
      
      // Buscar si el usuario ya existe en la plataforma
      const usersTableClient = this.storageService.getTableClient(STORAGE_TABLES.USERS);
      let targetUserId: string | null = null;
      
      const users = await usersTableClient.listEntities({
        queryOptions: { filter: `email eq '${targetEmail}'` }
      });
      
      for await (const user of users) {
        const userEmail = user.email as string;
        if (userEmail && userEmail.toLowerCase() === targetEmail.toLowerCase()) {
          targetUserId = user.id as string;
          break;
        }
      }
      
      // Verificar si ya existe un rol para este usuario/email y agente
      const rolesTableClient = this.storageService.getTableClient(STORAGE_TABLES.USER_ROLES);
      const existingRoles = rolesTableClient.listEntities({
        queryOptions: { 
          filter: targetUserId 
            ? `agentId eq '${agentId}' and userId eq '${targetUserId}'`
            : `agentId eq '${agentId}' and email eq '${targetEmail}'`
        }
      });
      
      for await (const existingRole of existingRoles) {
        if (existingRole.isActive) {
          throw createAppError(409, `El usuario ya tiene un rol asignado en este agente`);
        }
      }
      
      // Crear nuevo rol
      const roleId = uuidv4();
      const now = Date.now();
      
      const newRole: UserRole = {
        id: roleId,
        agentId,
        userId: targetUserId || '', // Puede estar vacío si el usuario aún no existe
        role: role as RoleType,
        invitedBy: userId,
        email: targetEmail,
        status: targetUserId ? InvitationStatus.ACCEPTED : InvitationStatus.PENDING,
        createdAt: now,
        isActive: true
      };
      
      // Guardar en Table Storage
      await rolesTableClient.createEntity({
        partitionKey: agentId,
        rowKey: roleId,
        ...newRole
      });
      
      // Si el usuario no existe, enviar invitación por email
      if (!targetUserId) {
        // Aquí enviaríamos la invitación por email
        // this.notificationService.sendRoleInvitation(targetEmail, agentId, roleId, role);
      }
      
      return {
        id: roleId,
        agentId,
        email: targetEmail,
        role,
        status: newRole.status,
        message: targetUserId 
          ? "Rol asignado con éxito" 
          : "Invitación enviada al usuario"
      };
    } catch (error: unknown) {
      this.logger.error(`Error al asignar rol para el agente ${agentId}:`, error);
      
      if (error && typeof error === 'object' && 'statusCode' in error) {
        throw error;
      }
      
      throw createAppError(500, 'Error al asignar rol');
    }
  }
  
  async revokeRole(agentId: string, userId: string, targetUserId: string): Promise<any> {
    try {
      // Verificar si el usuario tiene permisos para revocar roles
      await this.verifyRolePermission(agentId, userId);
      
      // No permitir revocar al propietario original
      const isOwner = await this.isUserOwner(agentId, targetUserId);
      if (isOwner) {
        throw createAppError(403, "No puedes revocar el rol del propietario del agente");
      }
      
      // Buscar el rol a revocar
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.USER_ROLES);
      const roles = tableClient.listEntities({
        queryOptions: { filter: `agentId eq '${agentId}' and userId eq '${targetUserId}' and isActive eq true` }
      });
      
      let roleFound = false;
      for await (const role of roles) {
        // Desactivar el rol
        await tableClient.updateEntity({
          partitionKey: agentId,
          rowKey: role.id as string,
          isActive: false,
          updatedAt: Date.now()
        }, "Merge");
        roleFound = true;
      }
      
      if (!roleFound) {
        throw createAppError(404, "Rol no encontrado");
      }
      
      return {
        agentId,
        targetUserId,
        message: "Rol revocado con éxito"
      };
    } catch (error: unknown) {
      this.logger.error(`Error al revocar rol para el agente ${agentId}:`, error);
      
      if (error && typeof error === 'object' && 'statusCode' in error) {
        throw error;
      }
      
      throw createAppError(500, 'Error al revocar rol');
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
      const hasRole = await this.userHasRole(agentId, userId);
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
  
  private async verifyRolePermission(agentId: string, userId: string): Promise<void> {
    try {
      // Verificar si el usuario es propietario
      const isOwner = await this.isUserOwner(agentId, userId);
      if (isOwner) {
        return;
      }
      
      // Verificar si el usuario es administrador
      const isAdmin = await this.userHasRole(agentId, userId, RoleType.ADMIN);
      if (!isAdmin) {
        throw createAppError(403, 'No tienes permiso para gestionar roles en este agente');
      }
    } catch (error) {
      if (error && typeof error === 'object' && 'statusCode' in error) {
        throw error;
      }
      throw createAppError(500, 'Error al verificar permisos de rol');
    }
  }
  
  private async isUserOwner(agentId: string, userId: string): Promise<boolean> {
    try {
      const agentsTable = this.storageService.getTableClient(STORAGE_TABLES.AGENTS);
      const agent = await agentsTable.getEntity('agent', agentId);
      return agent.userId === userId;
    } catch (error) {
      return false;
    }
  }
  
  private async userHasRole(agentId: string, userId: string, roleType?: RoleType): Promise<boolean> {
    try {
      const rolesTable = this.storageService.getTableClient(STORAGE_TABLES.USER_ROLES);
      
      let filter = `agentId eq '${agentId}' and userId eq '${userId}' and isActive eq true`;
      if (roleType) {
        filter += ` and role eq '${roleType}'`;
      }
      
      const roles = rolesTable.listEntities({
        queryOptions: { filter }
      });
      
      for await (const role of roles) {
        return true;
      }
      
      return false;
    } catch (error) {
      return false;
    }
  }
  
  private async enrichRolesWithUserInfo(roles: UserRole[]): Promise<any[]> {
    if (roles.length === 0) return [];
    
    const usersTable = this.storageService.getTableClient(STORAGE_TABLES.USERS);
    const enrichedRoles = [];
    
    for (const role of roles) {
      try {
        let userName = '';
        
        if (role.userId) {
          // Intentar obtener información del usuario
          try {
            const user = await usersTable.getEntity('user', role.userId);
            userName = `${user.firstName} ${user.lastName || ''}`.trim();
          } catch (error) {
            // Si no se encuentra el usuario, usar el email
            userName = role.email;
          }
        } else {
          userName = role.email;
        }
        
        enrichedRoles.push({
          ...role,
          userName
        });
      } catch (error) {
        this.logger.warn(`Error al enriquecer información del rol ${role.id}:`, error);
        enrichedRoles.push(role);
      }
    }
    
    return enrichedRoles;
  }
}