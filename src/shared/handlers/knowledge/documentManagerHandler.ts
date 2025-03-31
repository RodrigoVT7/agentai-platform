import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES, STORAGE_QUEUES, BLOB_CONTAINERS } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { HttpResponseInit } from "@azure/functions";
import { DocumentProcessingStatus, DocumentProcessingQueueMessage } from "../../models/document.model";

interface ListOptions {
  limit: number;
  skip: number;
  status?: string;
}

export class DocumentManagerHandler {
  private storageService: StorageService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }
  
  /**
   * Obtener detalles de un documento
   */
  public async getDocument(documentId: string, userId: string): Promise<HttpResponseInit> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.DOCUMENTS);
      
      // Buscar documento en todas las particiones ya que no sabemos el knowledgeBaseId
      const documents = await tableClient.listEntities({
        queryOptions: { filter: `RowKey eq '${documentId}'` }
      });
      
      let doc;
      for await (const entity of documents) {
        doc = entity;
        break;
      }
      
      if (!doc) {
        return {
          status: 404,
          jsonBody: { error: "Documento no encontrado" }
        };
      }
      
      // Verificar que el usuario tiene acceso a este documento
      const knowledgeBaseId = doc.partitionKey as string;
      const hasAccess = await this.checkKnowledgeBaseAccess(knowledgeBaseId, userId);
      
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para acceder a este documento" }
        };
      }
      
      // Obtener estadísticas de chunks/vectores
      const stats = await this.getDocumentStats(documentId, knowledgeBaseId);
      
      // Formatear respuesta
      return {
        status: 200,
        jsonBody: {
          id: doc.id,
          knowledgeBaseId: doc.knowledgeBaseId,
          name: doc.name,
          type: doc.type,
          storageUrl: doc.storageUrl,
          sizeMb: doc.sizeMb,
          processingStatus: doc.processingStatus,
          createdBy: doc.createdBy,
          createdAt: doc.createdAt,
          updatedAt: doc.updatedAt,
          isActive: doc.isActive,
          stats
        }
      };
    } catch (error) {
      this.logger.error(`Error al obtener documento ${documentId}:`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw createAppError(500, `Error al obtener documento: ${errorMessage}`);
    }
  }
  
  /**
   * Listar documentos de una base de conocimiento
   */
  public async listDocuments(knowledgeBaseId: string, userId: string, options: ListOptions): Promise<HttpResponseInit> {
    try {
      // Verificar que el usuario tiene acceso a la base de conocimiento
      const hasAccess = await this.checkKnowledgeBaseAccess(knowledgeBaseId, userId);
      
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para acceder a esta base de conocimiento" }
        };
      }
      
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.DOCUMENTS);
      
      // Construir filtro base
      let filter = `PartitionKey eq '${knowledgeBaseId}' and isActive eq true`;
      
      // Añadir filtro de estado si se proporciona
      if (options.status) {
        filter += ` and processingStatus eq '${options.status}'`;
      }
      
      const documents = [];
      const docEntities = await tableClient.listEntities({
        queryOptions: { filter }
      });
      
      // Recolectar todos los documentos
      const allDocs = [];
      for await (const doc of docEntities) {
        allDocs.push(doc);
      }
      
      // Aplicar paginación después de ordenar
      allDocs.sort((a, b) => {
        // Ordenar por fecha de creación (más reciente primero)
        const aTime = a.createdAt as number;
        const bTime = b.createdAt as number;
        return bTime - aTime;
      });
      
      // Aplicar salto y límite
      const paginatedDocs = allDocs.slice(options.skip, options.skip + options.limit);
      
      // Mapear a formato de respuesta
      for (const doc of paginatedDocs) {
        documents.push({
          id: doc.id,
          knowledgeBaseId: doc.knowledgeBaseId,
          name: doc.name,
          type: doc.type,
          sizeMb: doc.sizeMb,
          processingStatus: doc.processingStatus,
          createdAt: doc.createdAt,
          updatedAt: doc.updatedAt
        });
      }
      
      // Obtener conteos por estado para estadísticas
      const statusCounts = await this.getStatusCounts(knowledgeBaseId);
      
      return {
        status: 200,
        jsonBody: {
          documents,
          pagination: {
            total: allDocs.length,
            limit: options.limit,
            skip: options.skip
          },
          stats: statusCounts
        }
      };
    } catch (error) {
      this.logger.error(`Error al listar documentos para KB ${knowledgeBaseId}:`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw createAppError(500, `Error al listar documentos: ${errorMessage}`);
    }
  }
  
  /**
   * Eliminar un documento
   */
  public async deleteDocument(documentId: string, userId: string): Promise<HttpResponseInit> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.DOCUMENTS);
      
      // Buscar documento
      const documents = await tableClient.listEntities({
        queryOptions: { filter: `RowKey eq '${documentId}'` }
      });
      
      let doc;
      for await (const entity of documents) {
        doc = entity;
        break;
      }
      
      if (!doc) {
        return {
          status: 404,
          jsonBody: { error: "Documento no encontrado" }
        };
      }
      
      // Verificar que el usuario tiene acceso a este documento
      const knowledgeBaseId = doc.partitionKey as string;
      const hasAccess = await this.checkKnowledgeBaseAccess(knowledgeBaseId, userId);
      
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para eliminar este documento" }
        };
      }
      
      // Realizar eliminación lógica
      await tableClient.updateEntity({
        partitionKey: knowledgeBaseId,
        rowKey: documentId,
        isActive: false,
        updatedAt: Date.now()
      }, "Merge");
      
      // Eliminar vectores asociados
      await this.deleteVectors(documentId);
      
      this.logger.info(`Documento ${documentId} eliminado (desactivado)`);
      
      return {
        status: 200,
        jsonBody: {
          id: documentId,
          message: "Documento eliminado con éxito"
        }
      };
    } catch (error) {
      this.logger.error(`Error al eliminar documento ${documentId}:`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw createAppError(500, `Error al eliminar documento: ${errorMessage}`);
    }
  }
  
  /**
   * Reprocesar un documento
   */
  public async reprocessDocument(documentId: string, userId: string): Promise<HttpResponseInit> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.DOCUMENTS);
      
      // Buscar documento
      const documents = await tableClient.listEntities({
        queryOptions: { filter: `RowKey eq '${documentId}'` }
      });
      
      let doc;
      for await (const entity of documents) {
        doc = entity;
        break;
      }
      
      if (!doc) {
        return {
          status: 404,
          jsonBody: { error: "Documento no encontrado" }
        };
      }
      
      // Verificar que el usuario tiene acceso a este documento
      const knowledgeBaseId = doc.knowledgeBaseId as string;
      const agentId = await this.getAgentIdFromKnowledgeBase(knowledgeBaseId);
      
      if (!agentId) {
        return {
          status: 404,
          jsonBody: { error: "Base de conocimiento no encontrada" }
        };
      }
      
      const hasAccess = await this.checkKnowledgeBaseAccess(knowledgeBaseId, userId);
      
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para reprocesar este documento" }
        };
      }
      
      // Actualizar estado del documento
      await tableClient.updateEntity({
        partitionKey: knowledgeBaseId,
        rowKey: documentId,
        processingStatus: DocumentProcessingStatus.PENDING,
        updatedAt: Date.now()
      }, "Merge");
      
      // Eliminar vectores existentes
      await this.deleteVectors(documentId);
      
      // Encolar de nuevo para procesamiento
      const queueClient = this.storageService.getQueueClient(STORAGE_QUEUES.DOCUMENT_PROCESSING);
      
      const processingMessage: DocumentProcessingQueueMessage = {
        documentId,
        knowledgeBaseId,
        agentId,
        storageUrl: doc.storageUrl as string,
        originalName: doc.name as string,
        contentType: doc.type as string,
        uploadedAt: Date.now()
      };
      
      await queueClient.sendMessage(Buffer.from(JSON.stringify(processingMessage)).toString('base64'));
      
      this.logger.info(`Documento ${documentId} encolado para reprocesamiento`);
      
      return {
        status: 200,
        jsonBody: {
          id: documentId,
          status: DocumentProcessingStatus.PENDING,
          message: "Documento encolado para reprocesamiento"
        }
      };
    } catch (error) {
      this.logger.error(`Error al reprocesar documento ${documentId}:`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw createAppError(500, `Error al reprocesar documento: ${errorMessage}`);
    }
  }
  
  /**
   * Eliminar vectores asociados a un documento
   */
  private async deleteVectors(documentId: string): Promise<void> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.VECTORS);
      
      const vectors = await tableClient.listEntities({
        queryOptions: { filter: `documentId eq '${documentId}'` }
      });
      
      for await (const vector of vectors) {
        if (vector.partitionKey && vector.rowKey) {
          await tableClient.deleteEntity(vector.partitionKey, vector.rowKey);
        }
      }
      
      this.logger.debug(`Vectores eliminados para documento ${documentId}`);
    } catch (error) {
      this.logger.error(`Error al eliminar vectores para documento ${documentId}:`, error);
      // No propagamos el error para no interrumpir el flujo principal
    }
  }
  
  /**
   * Verificar si un usuario tiene acceso a una base de conocimiento
   */
  private async checkKnowledgeBaseAccess(knowledgeBaseId: string, userId: string): Promise<boolean> {
    try {
      // Obtener agentId de la base de conocimiento
      const kbTableClient = this.storageService.getTableClient(STORAGE_TABLES.KNOWLEDGE_BASES);
      
      let agentId: string | null = null;
      const knowledgeBases = await kbTableClient.listEntities({
        queryOptions: { filter: `RowKey eq '${knowledgeBaseId}'` }
      });
      
      for await (const kb of knowledgeBases) {
        agentId = kb.agentId as string;
        break;
      }
      
      if (!agentId) return false;
      
      // Verificar acceso al agente
      return await this.checkAgentAccess(agentId, userId);
    } catch (error) {
      this.logger.error(`Error al verificar acceso a KB ${knowledgeBaseId}:`, error);
      return false;
    }
  }
  
  /**
   * Verificar si un usuario tiene acceso a un agente
   */
  private async checkAgentAccess(agentId: string, userId: string): Promise<boolean> {
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
  
  /**
   * Obtener estadísticas de un documento
   */
  private async getDocumentStats(documentId: string, knowledgeBaseId: string): Promise<any> {
    try {
      // Contar vectores para este documento
      const vectorTableClient = this.storageService.getTableClient(STORAGE_TABLES.VECTORS);
      
      let vectorCount = 0;
      const vectors = await vectorTableClient.listEntities({
        queryOptions: { filter: `documentId eq '${documentId}'` }
      });
      
      for await (const vector of vectors) {
        vectorCount++;
      }
      
      // Obtener metadata de chunks procesados
      let chunkCount = 0;
      try {
        const containerClient = this.storageService.getBlobContainerClient(BLOB_CONTAINERS.PROCESSED_DOCUMENTS);
        const metadataBlobClient = containerClient.getBlockBlobClient(`${knowledgeBaseId}/${documentId}/metadata.json`);
        
        if (await metadataBlobClient.exists()) {
          const downloadResponse = await metadataBlobClient.download();
          const metadataText = await streamToString(downloadResponse.readableStreamBody);
          const metadata = JSON.parse(metadataText);
          
          chunkCount = metadata.chunkCount || 0;
        }
      } catch (error) {
        this.logger.warn(`Error al obtener metadata de chunks para documento ${documentId}:`, error);
      }
      
      return {
        vectorCount,
        chunkCount,
        vectorizationProgress: chunkCount > 0 ? Math.round((vectorCount / chunkCount) * 100) : 0
      };
    } catch (error) {
      this.logger.warn(`Error al obtener estadísticas para documento ${documentId}:`, error);
      return {
        vectorCount: 0,
        chunkCount: 0,
        vectorizationProgress: 0
      };
    }
  }
  
  /**
   * Obtener conteos por estado de procesamiento
   */
  private async getStatusCounts(knowledgeBaseId: string): Promise<Record<string, number>> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.DOCUMENTS);
      
      const counts: Record<string, number> = {
        total: 0,
        pending: 0,
        processing: 0,
        processed: 0,
        vectorized: 0,
        failed: 0
      };
      
      const documents = await tableClient.listEntities({
        queryOptions: { filter: `PartitionKey eq '${knowledgeBaseId}' and isActive eq true` }
      });
      
      for await (const doc of documents) {
        counts.total++;
        
        const status = doc.processingStatus as string;
        if (status && status in counts) {
          counts[status]++;
        }
      }
      
      return counts;
    } catch (error) {
      this.logger.warn(`Error al obtener conteos por estado para KB ${knowledgeBaseId}:`, error);
      return {
        total: 0,
        pending: 0,
        processing: 0,
        processed: 0,
        vectorized: 0,
        failed: 0
      };
    }
  }
  
  /**
   * Obtener agentId de una base de conocimiento
   */
  private async getAgentIdFromKnowledgeBase(knowledgeBaseId: string): Promise<string | null> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.KNOWLEDGE_BASES);
      
      const knowledgeBases = await tableClient.listEntities({
        queryOptions: { filter: `RowKey eq '${knowledgeBaseId}'` }
      });
      
      for await (const kb of knowledgeBases) {
        return kb.agentId as string;
      }
      
      return null;
    } catch (error) {
      this.logger.error(`Error al obtener agentId de KB ${knowledgeBaseId}:`, error);
      return null;
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