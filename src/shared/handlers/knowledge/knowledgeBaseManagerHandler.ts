import { v4 as uuidv4 } from "uuid";
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES, BLOB_CONTAINERS } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { HttpResponseInit } from "@azure/functions";

export class KnowledgeBaseManagerHandler {
  private storageService: StorageService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }
  
  /**
   * Crear una nueva base de conocimiento
   */
  public async createKnowledgeBase(data: any, userId: string): Promise<HttpResponseInit> {
    try {
      const { agentId, name, description } = data;
      
      // Verificar si el usuario tiene acceso al agente
      const hasAccess = await this.verifyAgentAccess(agentId, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para acceder a este agente" }
        };
      }
      
      // Generar nuevo ID para la base de conocimiento
      const knowledgeBaseId = uuidv4();
      const now = Date.now();
      
      // Guardar en Table Storage
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.KNOWLEDGE_BASES);
      
      await tableClient.createEntity({
        partitionKey: agentId,
        rowKey: knowledgeBaseId,
        id: knowledgeBaseId,
        agentId,
        name,
        description: description || "",
        createdBy: userId,
        createdAt: now,
        updatedAt: now,
        isActive: true
      });
      
      // Crear contenedor Blob para esta KB si no existe
      try {
        const containerClient = this.storageService.getBlobContainerClient(BLOB_CONTAINERS.KNOWLEDGE_BASES);
        await containerClient.createIfNotExists();
        
        const metadataBlob = containerClient.getBlockBlobClient(`${agentId}/${knowledgeBaseId}/metadata.json`);
        const metadata = {
          id: knowledgeBaseId,
          name,
          description: description || "",
          createdAt: now,
          createdBy: userId,
          agentId
        };
        
        await metadataBlob.upload(JSON.stringify(metadata), JSON.stringify(metadata).length);
      } catch (error) {
        this.logger.warn(`No se pudo crear metadata de blob para KB ${knowledgeBaseId}:`, error);
        // Continuamos aunque falle esto, no es crítico
      }
      
      this.logger.info(`Base de conocimiento ${knowledgeBaseId} creada para el agente ${agentId}`);
      
      return {
        status: 201,
        jsonBody: {
          id: knowledgeBaseId,
          agentId,
          name,
          description: description || "",
          createdAt: now,
          createdBy: userId
        }
      };
    } catch (error) {
      this.logger.error("Error al crear base de conocimiento:", error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw createAppError(500, `Error al crear base de conocimiento: ${errorMessage}`);
    }
  }
  
  /**
   * Obtener detalles de una base de conocimiento
   */
  public async getKnowledgeBase(knowledgeBaseId: string, userId: string): Promise<HttpResponseInit> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.KNOWLEDGE_BASES);
      
      // Buscar KB en todas las particiones ya que no sabemos el agentId
      const knowledgeBases = await tableClient.listEntities({
        queryOptions: { filter: `RowKey eq '${knowledgeBaseId}'` }
      });
      
      let kb;
      for await (const entity of knowledgeBases) {
        kb = entity;
        break;
      }
      
      if (!kb) {
        return {
          status: 404,
          jsonBody: { error: "Base de conocimiento no encontrada" }
        };
      }
      
      // Verificar si el usuario tiene acceso al agente de esta KB
      const hasAccess = await this.verifyAgentAccess(kb.agentId as string, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para acceder a esta base de conocimiento" }
        };
      }
      
      // Contar documentos
      const documentCount = await this.countDocuments(knowledgeBaseId);
      
      // Obtener estadísticas
      const stats = await this.getKnowledgeBaseStats(knowledgeBaseId);
      
      return {
        status: 200,
        jsonBody: {
          id: kb.id,
          agentId: kb.agentId,
          name: kb.name,
          description: kb.description,
          createdAt: kb.createdAt,
          updatedAt: kb.updatedAt,
          createdBy: kb.createdBy,
          isActive: kb.isActive,
          stats: {
            documentCount,
            ...stats
          }
        }
      };
    } catch (error) {
      this.logger.error(`Error al obtener base de conocimiento ${knowledgeBaseId}:`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw createAppError(500, `Error al obtener base de conocimiento: ${errorMessage}`);
    }
  }
  
  /**
   * Listar bases de conocimiento para un agente
   */
  public async listKnowledgeBases(agentId: string, userId: string): Promise<HttpResponseInit> {
    try {
      // Verificar si el usuario tiene acceso al agente
      const hasAccess = await this.verifyAgentAccess(agentId, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para acceder a este agente" }
        };
      }
      
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.KNOWLEDGE_BASES);
      
      const kbs = [];
      const knowledgeBases = await tableClient.listEntities({
        queryOptions: { filter: `PartitionKey eq '${agentId}' and isActive eq true` }
      });
      
      for await (const kb of knowledgeBases) {
        // Contar documentos para cada KB
        const documentCount = await this.countDocuments(kb.id as string);
        
        kbs.push({
          id: kb.id,
          agentId: kb.agentId,
          name: kb.name,
          description: kb.description,
          createdAt: kb.createdAt,
          updatedAt: kb.updatedAt,
          documentCount
        });
      }
      
      return {
        status: 200,
        jsonBody: {
          knowledgeBases: kbs,
          count: kbs.length
        }
      };
    } catch (error) {
      this.logger.error(`Error al listar bases de conocimiento para agente ${agentId}:`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw createAppError(500, `Error al listar bases de conocimiento: ${errorMessage}`);
    }
  }
  
  /**
   * Actualizar una base de conocimiento existente
   */
  public async updateKnowledgeBase(knowledgeBaseId: string, data: any, userId: string): Promise<HttpResponseInit> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.KNOWLEDGE_BASES);
      
      // Obtener KB existente
      let kb;
      const knowledgeBases = await tableClient.listEntities({
        queryOptions: { filter: `RowKey eq '${knowledgeBaseId}'` }
      });
      
      for await (const entity of knowledgeBases) {
        kb = entity;
        break;
      }
      
      if (!kb) {
        return {
          status: 404,
          jsonBody: { error: "Base de conocimiento no encontrada" }
        };
      }
      
      // Verificar si el usuario tiene acceso al agente de esta KB
      const hasAccess = await this.verifyAgentAccess(kb.agentId as string, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para modificar esta base de conocimiento" }
        };
      }
      
      // Preparar datos para actualización
      const now = Date.now();
      const updateData: any = {
        partitionKey: kb.partitionKey,
        rowKey: kb.rowKey,
        updatedAt: now
      };
      
      // Actualizar solo los campos proporcionados
      if (data.name !== undefined) updateData.name = data.name;
      if (data.description !== undefined) updateData.description = data.description;
      if (data.isActive !== undefined) updateData.isActive = data.isActive;
      
      // Actualizar en Table Storage
      await tableClient.updateEntity(updateData, "Merge");
      
      // También actualizar metadata en Blob si es necesario
      if (data.name !== undefined || data.description !== undefined) {
        try {
          const containerClient = this.storageService.getBlobContainerClient(BLOB_CONTAINERS.KNOWLEDGE_BASES);
          const metadataBlob = containerClient.getBlockBlobClient(`${kb.agentId}/${knowledgeBaseId}/metadata.json`);
          
          if (await metadataBlob.exists()) {
            const downloadResponse = await metadataBlob.download();
            const metadataText = await streamToString(downloadResponse.readableStreamBody);
            const metadata = JSON.parse(metadataText);
            
            // Actualizar metadatos
            if (data.name !== undefined) metadata.name = data.name;
            if (data.description !== undefined) metadata.description = data.description;
            metadata.updatedAt = now;
            
            await metadataBlob.upload(JSON.stringify(metadata), JSON.stringify(metadata).length);
          }
        } catch (error) {
          this.logger.warn(`No se pudo actualizar metadata de blob para KB ${knowledgeBaseId}:`, error);
          // Continuamos aunque falle esto, no es crítico
        }
      }
      
      this.logger.info(`Base de conocimiento ${knowledgeBaseId} actualizada`);
      
      return {
        status: 200,
        jsonBody: {
          id: knowledgeBaseId,
          agentId: kb.agentId,
          name: data.name !== undefined ? data.name : kb.name,
          description: data.description !== undefined ? data.description : kb.description,
          updatedAt: now,
          message: "Base de conocimiento actualizada con éxito"
        }
      };
    } catch (error) {
      this.logger.error(`Error al actualizar base de conocimiento ${knowledgeBaseId}:`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw createAppError(500, `Error al actualizar base de conocimiento: ${errorMessage}`);
    }
  }
  
  /**
   * Eliminar una base de conocimiento
   */
  public async deleteKnowledgeBase(knowledgeBaseId: string, userId: string): Promise<HttpResponseInit> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.KNOWLEDGE_BASES);
      
      // Obtener KB existente
      let kb;
      const knowledgeBases = await tableClient.listEntities({
        queryOptions: { filter: `RowKey eq '${knowledgeBaseId}'` }
      });
      
      for await (const entity of knowledgeBases) {
        kb = entity;
        break;
      }
      
      if (!kb) {
        return {
          status: 404,
          jsonBody: { error: "Base de conocimiento no encontrada" }
        };
      }
      
      // Verificar si el usuario tiene acceso al agente de esta KB
      const hasAccess = await this.verifyAgentAccess(kb.agentId as string, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para eliminar esta base de conocimiento" }
        };
      }
      
      // Realizar eliminación lógica
      if (kb && kb.partitionKey && kb.rowKey) {
        await tableClient.updateEntity({
          partitionKey: kb.partitionKey as string,
          rowKey: kb.rowKey as string,
          isActive: false,
          updatedAt: Date.now()
        }, "Merge");
      }
      
      // Desactivar documentos asociados
      await this.deactivateDocuments(knowledgeBaseId);
      
      this.logger.info(`Base de conocimiento ${knowledgeBaseId} eliminada (desactivada)`);
      
      return {
        status: 200,
        jsonBody: {
          id: knowledgeBaseId,
          message: "Base de conocimiento eliminada con éxito"
        }
      };
    } catch (error) {
      this.logger.error(`Error al eliminar base de conocimiento ${knowledgeBaseId}:`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw createAppError(500, `Error al eliminar base de conocimiento: ${errorMessage}`);
    }
  }
  
  /**
   * Desactivar documentos asociados a una base de conocimiento
   */
  private async deactivateDocuments(knowledgeBaseId: string): Promise<void> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.DOCUMENTS);
      
      const now = Date.now();
      const documents = await tableClient.listEntities({
        queryOptions: { filter: `PartitionKey eq '${knowledgeBaseId}' and isActive eq true` }
      });
      
      for await (const doc of documents) {
        if (doc.partitionKey && doc.rowKey) {
          await tableClient.updateEntity({
            partitionKey: doc.partitionKey as string,
            rowKey: doc.rowKey as string,
            isActive: false,
            updatedAt: now
          }, "Merge");
        }
      }
    } catch (error) {
      this.logger.error(`Error al desactivar documentos para KB ${knowledgeBaseId}:`, error);
      // No propagamos el error para no interrumpir el flujo principal
    }
  }
  
  /**
   * Contar documentos en una base de conocimiento
   */
  private async countDocuments(knowledgeBaseId: string): Promise<number> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.DOCUMENTS);
      
      let count = 0;
      const documents = await tableClient.listEntities({
        queryOptions: { filter: `PartitionKey eq '${knowledgeBaseId}' and isActive eq true` }
      });
      
      for await (const doc of documents) {
        count++;
      }
      
      return count;
    } catch (error) {
      this.logger.warn(`Error al contar documentos para KB ${knowledgeBaseId}:`, error);
      return 0;
    }
  }
  
  /**
   * Obtener estadísticas de una base de conocimiento
   */
  private async getKnowledgeBaseStats(knowledgeBaseId: string): Promise<any> {
    try {
      // Contar vectores
      const vectorTableClient = this.storageService.getTableClient(STORAGE_TABLES.VECTORS);
      
      let vectorCount = 0;
      const vectors = await vectorTableClient.listEntities({
        queryOptions: { filter: `PartitionKey eq '${knowledgeBaseId}'` }
      });
      
      for await (const vector of vectors) {
        vectorCount++;
      }
      
      // Obtener estado de procesamiento de documentos
      const docTableClient = this.storageService.getTableClient(STORAGE_TABLES.DOCUMENTS);
      
      const processingStatus = {
        pending: 0,
        processing: 0,
        processed: 0,
        vectorized: 0,
        failed: 0
      };
      
      const documents = await docTableClient.listEntities({
        queryOptions: { filter: `PartitionKey eq '${knowledgeBaseId}' and isActive eq true` }
      });
      
      for await (const doc of documents) {
        const status = doc.processingStatus as string;
        if (status && processingStatus.hasOwnProperty(status)) {
          processingStatus[status as keyof typeof processingStatus]++;
        }
      }
      
      return {
        vectorCount,
        processingStatus
      };
    } catch (error) {
      this.logger.warn(`Error al obtener estadísticas para KB ${knowledgeBaseId}:`, error);
      return {
        vectorCount: 0,
        processingStatus: {
          pending: 0,
          processing: 0,
          processed: 0,
          vectorized: 0,
          failed: 0
        }
      };
    }
  }
  
  /**
   * Verificar acceso de un usuario a un agente
   */
  private async verifyAgentAccess(agentId: string, userId: string): Promise<boolean> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.AGENTS);
      
      try {
        const agent = await tableClient.getEntity('agent', agentId);
        
        // Si el usuario es propietario, tiene acceso
        if (agent.userId === userId) {
          return true;
        }
      } catch (error) {
        return false;
      }
      
      // Si no es propietario, verificar roles
      const rolesClient = this.storageService.getTableClient(STORAGE_TABLES.USER_ROLES);
      const roles = await rolesClient.listEntities({
        queryOptions: { filter: `agentId eq '${agentId}' and userId eq '${userId}' and isActive eq true` }
      });
      
      for await (const role of roles) {
        return true;
      }
      
      return false;
    } catch (error) {
      this.logger.error(`Error al verificar acceso del usuario ${userId} al agente ${agentId}:`, error);
      return false;
    }
  }
}

/**
 * Función auxiliar para convertir stream a string
 */
async function streamToString(readableStream: NodeJS.ReadableStream | undefined): Promise<string> {
  if (!readableStream) return '';
  
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    readableStream.on('data', (data) => {
      chunks.push(Buffer.from(data));
    });
    readableStream.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    readableStream.on('error', reject);
  });
}