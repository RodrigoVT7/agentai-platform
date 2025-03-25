// src/shared/handlers/knowledge/embeddingGeneratorHandler.ts
import { StorageService } from "../../services/storage.service";
import { OpenAIService } from "../../services/openai.service";
import { STORAGE_TABLES, BLOB_CONTAINERS } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { DocumentProcessingStatus } from "../../models/document.model";
import { EmbeddingQueueMessage } from "../../models/documentProcessor.model";
import { EmbeddingResult, Vector } from "../../models/embedding.model";

export class EmbeddingGeneratorHandler {
  private storageService: StorageService;
  private openaiService: OpenAIService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.logger = logger || createLogger();
    this.storageService = new StorageService();
    this.openaiService = new OpenAIService(this.logger);
  }
  
  /**
   * Procesa un mensaje de la cola y genera embeddings
   */
  public async execute(message: EmbeddingQueueMessage): Promise<EmbeddingResult> {
    const { chunkId, documentId, knowledgeBaseId, content, agentId } = message;
    
    try {
      this.logger.info(`Generando embedding para chunk ${chunkId} del documento ${documentId}`);
      
      // Comprobar si este chunk ya tiene un embedding (para evitar duplicados)
      const existingVector = await this.getExistingVector(chunkId, knowledgeBaseId);
      
      if (existingVector) {
        this.logger.info(`El chunk ${chunkId} ya tiene un embedding. Omitiendo.`);
        return {
          chunkId,
          documentId,
          knowledgeBaseId,
          success: true,
          vector: existingVector.vector
        };
      }
      
      // Generar embedding
      const vector = await this.openaiService.getEmbedding(content);
      
      if (!vector || vector.length === 0) {
        throw createAppError(500, `Error al generar embedding para chunk ${chunkId}`);
      }
      
      // Almacenar el vector en Table Storage
      await this.storeVector(chunkId, documentId, knowledgeBaseId, vector, content);
      
      // Comprobar si todos los chunks tienen embedding y actualizar estado del documento
      await this.checkDocumentCompletion(documentId, knowledgeBaseId);
      
      this.logger.info(`Embedding generado con éxito para chunk ${chunkId}`);
      
      return {
        chunkId,
        documentId,
        knowledgeBaseId,
        success: true,
        vector
      };
    } catch (error) {
      this.logger.error(`Error al generar embedding para chunk ${chunkId}:`, error);
      
      // No actualizar documento a fallido si solo falla un chunk
      return {
        chunkId,
        documentId,
        knowledgeBaseId,
        success: false,
        error: error.message || 'Error desconocido al generar embedding'
      };
    }
  }
  
  /**
   * Comprueba si un chunk ya tiene un vector
   */
  private async getExistingVector(chunkId: string, knowledgeBaseId: string): Promise<Vector | null> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.VECTORS);
      
      const vectors = await tableClient.listEntities({
        queryOptions: { filter: `partitionKey eq '${knowledgeBaseId}' and rowKey eq '${chunkId}'` }
      });
      
      for await (const vector of vectors) {
        return {
          id: vector.id,
          documentId: vector.documentId,
          chunkId: vector.chunkId,
          knowledgeBaseId: vector.knowledgeBaseId,
          vector: JSON.parse(vector.vector),
          content: vector.content,
          metadata: vector.metadata ? JSON.parse(vector.metadata) : undefined,
          createdAt: vector.createdAt
        } as Vector;
      }
      
      return null;
    } catch (error) {
      this.logger.warn(`Error al buscar vector existente para chunk ${chunkId}:`, error);
      return null;
    }
  }
  
  /**
   * Almacena un vector en Table Storage
   */
  private async storeVector(
    chunkId: string,
    documentId: string,
    knowledgeBaseId: string,
    vector: number[],
    content: string
  ): Promise<void> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.VECTORS);
      
      const now = Date.now();
      
      // Crear entidad para Azure Table Storage
      const vectorEntity = {
        partitionKey: knowledgeBaseId,
        rowKey: chunkId,
        id: chunkId,
        documentId,
        chunkId,
        knowledgeBaseId,
        vector: JSON.stringify(vector),  // Convertir array a string para almacenamiento
        content,
        createdAt: now
      };
      
      await tableClient.createEntity(vectorEntity);
      
      this.logger.debug(`Vector almacenado para chunk ${chunkId}`);
    } catch (error) {
      this.logger.error(`Error al almacenar vector para chunk ${chunkId}:`, error);
      throw createAppError(500, `Error al almacenar vector: ${error.message}`);
    }
  }
  
  /**
   * Comprueba si todos los chunks de un documento tienen embeddings
   * y actualiza el estado del documento si es así
   */
  private async checkDocumentCompletion(documentId: string, knowledgeBaseId: string): Promise<void> {
    try {
      // Obtener metadatos del documento procesado
      const containerClient = this.storageService.getBlobContainerClient(BLOB_CONTAINERS.PROCESSED_DOCUMENTS);
      const metadataBlobClient = containerClient.getBlobClient(`${knowledgeBaseId}/${documentId}/metadata.json`);
      
      // Verificar si existe
      const exists = await metadataBlobClient.exists();
      
      if (!exists) {
        this.logger.warn(`No se encontraron metadatos para el documento ${documentId}`);
        return;
      }
      
      // Descargar y parsear metadatos
      const downloadResponse = await metadataBlobClient.download();
      const chunks: Buffer[] = [];
      
      // @ts-ignore - readableStreamBody existe pero TypeScript no lo reconoce
      for await (const chunk of downloadResponse.readableStreamBody) {
        chunks.push(Buffer.from(chunk));
      }
      
      const metadata = JSON.parse(Buffer.concat(chunks).toString());
      
      // Verificar cuántos chunks tiene el documento
      const totalChunks = metadata.chunkCount || 0;
      
      if (totalChunks === 0) {
        this.logger.warn(`El documento ${documentId} no tiene chunks en los metadatos`);
        return;
      }
      
      // Contar cuántos chunks tienen embeddings
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.VECTORS);
      
      let chunkCount = 0;
      const vectors = await tableClient.listEntities({
        queryOptions: { filter: `documentId eq '${documentId}'` }
      });
      
      for await (const vector of vectors) {
        chunkCount++;
      }
      
      this.logger.debug(`Documento ${documentId}: ${chunkCount}/${totalChunks} chunks con embeddings`);
      
      // Si todos los chunks tienen embeddings, actualizar estado del documento
      if (chunkCount >= totalChunks) {
        await this.updateDocumentStatus(documentId, knowledgeBaseId, DocumentProcessingStatus.VECTORIZED);
        this.logger.info(`Documento ${documentId} completamente vectorizado`);
      }
    } catch (error) {
      this.logger.error(`Error al verificar completitud del documento ${documentId}:`, error);
      // No propagamos el error para no detener el proceso
    }
  }
  
  /**
   * Actualiza el estado de procesamiento del documento
   */
  private async updateDocumentStatus(
    documentId: string,
    knowledgeBaseId: string,
    status: DocumentProcessingStatus
  ): Promise<void> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.DOCUMENTS);
      
      await tableClient.updateEntity({
        partitionKey: knowledgeBaseId,
        rowKey: documentId,
        processingStatus: status,
        updatedAt: Date.now()
      }, "Merge");
      
      this.logger.debug(`Estado del documento ${documentId} actualizado a ${status}`);
    } catch (error) {
      this.logger.error(`Error al actualizar estado del documento ${documentId}:`, error);
    }
  }
}