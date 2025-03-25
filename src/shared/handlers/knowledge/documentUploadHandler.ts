// src/shared/handlers/knowledge/documentUploadHandler.ts
import { v4 as uuidv4 } from "uuid";
import * as crypto from "crypto";
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES, STORAGE_QUEUES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { DocumentUploadValidator } from "../../validators/knowledge/documentUploadValidator";
import { 
  DocumentUploadRequest, 
  DocumentUploadResponse, 
  DocumentProcessingStatus,
  DocumentProcessingQueueMessage
} from "../../models/document.model";

export class DocumentUploadHandler {
  private storageService: StorageService;
  private validator: DocumentUploadValidator;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.validator = new DocumentUploadValidator(logger);
    this.logger = logger || createLogger();
  }
  
  /**
   * Procesa la subida de un documento
   * @param fileData Datos del archivo
   * @param userId ID del usuario
   * @param agentId ID del agente
   * @param knowledgeBaseId ID de la base de conocimiento
   * @returns Resultado del proceso
   */
  public async execute(
    fileData: DocumentUploadRequest,
    userId: string,
    agentId: string,
    knowledgeBaseId: string
  ): Promise<DocumentUploadResponse> {
    try {
      // Validar si la base de conocimiento existe y pertenece al agente
      const isValidKnowledgeBase = await this.validator.validateKnowledgeBase(agentId, knowledgeBaseId);
      
      if (!isValidKnowledgeBase) {
        throw createAppError(404, "Base de conocimiento no encontrada o no pertenece al agente");
      }
      
      // Generar ID único para el documento
      const documentId = uuidv4();
      
      // Calcular hash del archivo para verificación de integridad
      const fileHash = crypto.createHash('md5').update(fileData.buffer).digest('hex');
      
      // Preparar el nombre del blob
      const originalExtension = this.getFileExtension(fileData.originalname);
      const blobName = `${agentId}/${knowledgeBaseId}/${documentId}${originalExtension}`;
      
      // Subir archivo a Blob Storage
      const containerClient = this.storageService.getBlobContainerClient("documents");
      
      // Asegurar que el contenedor existe
      await containerClient.createIfNotExists();
      
      // Subir el archivo
      const blockBlobClient = containerClient.getBlockBlobClient(blobName);
      await blockBlobClient.upload(fileData.buffer, fileData.size);
      
      // Obtener URL del blob (necesaria para procesamiento posterior)
      const blobUrl = blockBlobClient.url;
      
      // Registrar documento en Table Storage
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.DOCUMENTS);
      
      const now = Date.now();
      const sizeMb = fileData.size / (1024 * 1024);
      
      const documentEntry = {
        partitionKey: knowledgeBaseId,
        rowKey: documentId,
        id: documentId,
        knowledgeBaseId: knowledgeBaseId,
        name: fileData.originalname,
        type: fileData.mimetype,
        storageUrl: blobUrl,
        sizeMb: sizeMb,
        processingStatus: DocumentProcessingStatus.PENDING,
        documentHash: fileHash, 
        createdBy: userId,
        createdAt: now,
        isActive: true,
        metadata: JSON.stringify({
          originalName: fileData.originalname,
          contentType: fileData.mimetype,
          size: fileData.size
        })
      };
      
      await tableClient.createEntity(documentEntry);
      
      // Preparar mensaje para la cola de procesamiento
      const processingMessage: DocumentProcessingQueueMessage = {
        documentId,
        knowledgeBaseId,
        agentId,
        storageUrl: blobUrl,
        originalName: fileData.originalname,
        contentType: fileData.mimetype,
        uploadedAt: now
      };
      
      // Encolar documento para procesamiento
      const queueClient = this.storageService.getQueueClient(STORAGE_QUEUES.DOCUMENT_PROCESSING);
      await queueClient.sendMessage(Buffer.from(JSON.stringify(processingMessage)).toString('base64'));
      
      // Actualizamos el timestamp de la base de conocimiento
      const knowledgeBaseTableClient = this.storageService.getTableClient(STORAGE_TABLES.KNOWLEDGE_BASES);
      await knowledgeBaseTableClient.updateEntity({
        partitionKey: agentId,
        rowKey: knowledgeBaseId,
        updatedAt: now
      }, "Merge");
      
      this.logger.info(`Documento ${documentId} subido exitosamente para la base de conocimiento ${knowledgeBaseId}`);
      
      // Retornar información del documento creado
      return {
        documentId,
        knowledgeBaseId,
        name: fileData.originalname,
        type: fileData.mimetype,
        sizeMb: parseFloat(sizeMb.toFixed(2)),
        status: DocumentProcessingStatus.PENDING,
        message: "Documento subido exitosamente y programado para procesamiento"
      };
    } catch (error) {
      this.logger.error(`Error en el procesamiento del documento:`, error);
      throw error;
    }
  }
  
  /**
   * Obtiene la extensión de un archivo
   * @param filename Nombre del archivo
   * @returns Extensión del archivo
   */
  private getFileExtension(filename: string): string {
    const parts = filename.split('.');
    return parts.length > 1 ? `.${parts[parts.length - 1]}` : '';
  }
}