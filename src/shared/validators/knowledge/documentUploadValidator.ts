// src/shared/validators/knowledge/documentUploadValidator.ts
import { ValidationResult } from "../../models/validation.model";
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { DocumentUploadRequest } from "../../models/document.model";

export class DocumentUploadValidator {
  private storageService: StorageService;
  private logger: Logger;
  
  // Tipos de archivos permitidos
  private allowedFileTypes = [
    'application/pdf',
    'text/plain',
    'text/markdown',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'text/csv',
    'application/json'
  ];
  
  // Extensiones de archivo permitidas
  private allowedFileExtensions = [
    '.pdf', '.txt', '.md', '.doc', '.docx', '.csv', '.json'
  ];
  
  // Tamaño máximo del archivo (10 MB)
  private maxFileSize = 10 * 1024 * 1024;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }
  
  /**
   * Valida los datos del archivo
   */
  public validate(fileData: DocumentUploadRequest): ValidationResult {
    const errors: string[] = [];
    
    // Validar buffer del archivo
    if (!fileData.buffer || !(fileData.buffer instanceof Buffer)) {
      errors.push("El archivo no tiene un buffer válido");
    }
    
    // Validar tipo de archivo
    if (!fileData.mimetype || !this.allowedFileTypes.includes(fileData.mimetype)) {
      errors.push(`Tipo de archivo no permitido: ${fileData.mimetype}. Tipos permitidos: ${this.allowedFileTypes.join(', ')}`);
    }
    
    // Validar extensión del archivo
    if (!fileData.originalname) {
      errors.push("El archivo no tiene un nombre original");
    } else {
      const extension = this.getFileExtension(fileData.originalname);
      if (!this.allowedFileExtensions.includes(extension.toLowerCase())) {
        errors.push(`Extensión de archivo no permitida: ${extension}. Extensiones permitidas: ${this.allowedFileExtensions.join(', ')}`);
      }
    }
    
    // Validar tamaño del archivo
    if (fileData.size > this.maxFileSize) {
      errors.push(`El archivo excede el tamaño máximo permitido de ${this.maxFileSize / (1024 * 1024)} MB`);
    }
    
    return {
      isValid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }
  
  /**
   * Valida si el usuario tiene acceso al agente
   */
  public async validateAgentAccess(userId: string, agentId: string): Promise<boolean> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.AGENTS);
      
      // Buscar el agente
      let hasAccess = false;
      const agents = await tableClient.listEntities({
        queryOptions: { filter: `userId eq '${userId}' and id eq '${agentId}'` }
      });
      
      for await (const agent of agents) {
        if (agent.id === agentId && agent.userId === userId) {
          hasAccess = true;
          break;
        }
      }
      
      // Si no se encuentra directamente, buscar en roles de agente
      if (!hasAccess) {
        const rolesClient = this.storageService.getTableClient(STORAGE_TABLES.USER_ROLES);
        const roles = await rolesClient.listEntities({
          queryOptions: { filter: `userId eq '${userId}' and agentId eq '${agentId}'` }
        });
        
        for await (const role of roles) {
          if (role.isActive) {
            hasAccess = true;
            break;
          }
        }
      }
      
      return hasAccess;
    } catch (error) {
      this.logger.error(`Error al validar acceso del usuario ${userId} al agente ${agentId}:`, error);
      return false;
    }
  }
  
  /**
   * Valida si la base de conocimiento existe y pertenece al agente
   */
  public async validateKnowledgeBase(agentId: string, knowledgeBaseId: string): Promise<boolean> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.KNOWLEDGE_BASES);
      
      const knowledgeBases = await tableClient.listEntities({
        queryOptions: { filter: `agentId eq '${agentId}' and id eq '${knowledgeBaseId}'` }
      });
      
      for await (const kb of knowledgeBases) {
        if (kb.id === knowledgeBaseId && kb.agentId === agentId) {
          return true;
        }
      }
      
      return false;
    } catch (error) {
      this.logger.error(`Error al validar base de conocimiento ${knowledgeBaseId} del agente ${agentId}:`, error);
      return false;
    }
  }
  
  /**
   * Obtiene la extensión de un archivo
   */
  private getFileExtension(filename: string): string {
    const parts = filename.split('.');
    return parts.length > 1 ? `.${parts[parts.length - 1]}` : '';
  }
}