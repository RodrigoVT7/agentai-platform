// src/shared/handlers/knowledge/documentProcessorHandler.ts
import { v4 as uuidv4 } from "uuid";
import { BlobServiceClient } from "@azure/storage-blob";
import { TableClient } from "@azure/data-tables";
import * as pdfjs from "pdfjs-dist";
import * as XLSX from "xlsx";
import * as mammoth from "mammoth";

import { StorageService } from "../../services/storage.service";
import {
  BLOB_CONTAINERS,
  STORAGE_TABLES,
  STORAGE_QUEUES,
  EMBEDDING_CONFIG,
} from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import {
  DocumentProcessingStatus,
  DocumentProcessingQueueMessage,
} from "../../models/document.model";
import {
  DocumentChunk,
  ProcessingResult,
  EmbeddingQueueMessage,
} from "../../models/documentProcessor.model";

export class DocumentProcessorHandler {
  private storageService: StorageService;
  private logger: Logger;

  // Configuración para chunking
  private chunkSize = EMBEDDING_CONFIG.CHUNK_SIZE;
  private chunkOverlap = EMBEDDING_CONFIG.CHUNK_OVERLAP;
  private maxTokensPerChunk = EMBEDDING_CONFIG.MAX_TOKENS_PER_CHUNK;

  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }

  /**
   * Procesa un documento desde la cola
   */
  public async execute(
    message: DocumentProcessingQueueMessage
  ): Promise<ProcessingResult> {
    const { documentId, knowledgeBaseId, agentId, storageUrl } = message;

    try {
      this.logger.info(
        `Iniciando procesamiento del documento ${documentId} para base de conocimiento ${knowledgeBaseId}`
      );

      // Actualizar estado del documento a 'processing'
      await this.updateDocumentStatus(
        documentId,
        knowledgeBaseId,
        DocumentProcessingStatus.PROCESSING
      );

      // Descargar el documento desde Blob Storage
      const documentContent = await this.downloadDocument(storageUrl);

      if (!documentContent || !documentContent.buffer) {
        throw createAppError(
          500,
          `No se pudo descargar el documento ${documentId}`
        );
      }

      // Extraer texto según el tipo de documento
      let extractedText = await this.extractText(
        documentContent.buffer,
        message.contentType,
        message.originalName
      );

      if (!extractedText || extractedText.trim() === "") {
        throw createAppError(
          422,
          `No se pudo extraer texto del documento ${documentId}`
        );
      }

      // Normalizar el texto extraído
      extractedText = this.normalizeText(extractedText);

      // Dividir en chunks
      const chunks = this.splitIntoChunks(
        extractedText,
        documentId,
        knowledgeBaseId
      );

      if (chunks.length === 0) {
        throw createAppError(
          422,
          `No se pudieron crear chunks para el documento ${documentId}`
        );
      }

      // Guardar los chunks procesados en Blob Storage
      await this.saveProcessedChunks(
        chunks,
        documentId,
        knowledgeBaseId,
        agentId
      );

      // Actualizar estado del documento a 'processed'
      await this.updateDocumentStatus(
        documentId,
        knowledgeBaseId,
        DocumentProcessingStatus.PROCESSED
      );

      // Encolar chunks para generación de embeddings
      await this.queueChunksForEmbeddings(
        chunks,
        documentId,
        knowledgeBaseId,
        agentId
      );

      this.logger.info(
        `Documento ${documentId} procesado con éxito. Se generaron ${chunks.length} chunks`
      );

      return {
        documentId,
        knowledgeBaseId,
        status: DocumentProcessingStatus.PROCESSED,
        chunks,
      };
    } catch (error: unknown) {
      this.logger.error(`Error al procesar documento ${documentId}:`, error);

      // Actualizar estado del documento a 'failed'
      await this.updateDocumentStatus(
        documentId,
        knowledgeBaseId,
        DocumentProcessingStatus.FAILED,
        error
      );

      // Verificar si es un AppError
      if (error && typeof error === "object" && "statusCode" in error) {
        throw error;
      }

      // Crear un mensaje de error genérico
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw createAppError(500, `Error al procesar documento: ${errorMessage}`);
    }
  }

  /**
   * Actualiza el estado de procesamiento del documento
   */
  private async updateDocumentStatus(
    documentId: string,
    knowledgeBaseId: string,
    status: DocumentProcessingStatus,
    error?: unknown
  ): Promise<void> {
    try {
      const tableClient = this.storageService.getTableClient(
        STORAGE_TABLES.DOCUMENTS
      );

      const updateEntity: any = {
        partitionKey: knowledgeBaseId,
        rowKey: documentId,
        processingStatus: status,
        updatedAt: Date.now(),
      };

      if (error) {
        // Asegurar que error.message sea un string
        const errorMessage =
          error instanceof Error
            ? error.message
            : typeof error === "object" && error !== null && "message" in error
            ? String((error as { message: unknown }).message)
            : String(error);

        updateEntity.processingError = errorMessage;
      }

      await tableClient.updateEntity(updateEntity, "Merge");

      this.logger.debug(
        `Estado del documento ${documentId} actualizado a ${status}`
      );
    } catch (error) {
      this.logger.error(
        `Error al actualizar estado del documento ${documentId}:`,
        error
      );
      // No relanzamos el error para no interrumpir el flujo principal
    }
  }

  /**
   * Descarga un documento desde Blob Storage
   */
  private async downloadDocument(
    storageUrl: string
  ): Promise<{ buffer: Buffer; metadata?: any }> {
    try {
      // Extraer el nombre del contenedor y el blob de la URL
      const url = new URL(storageUrl);
      const pathParts = url.pathname.split("/");
      const containerName = pathParts[1]; // primer parte después de la primera /
      const blobName = pathParts.slice(2).join("/"); // el resto del path

      const containerClient =
        this.storageService.getBlobContainerClient(containerName);
      const blobClient = containerClient.getBlobClient(blobName);

      // Descargar el blob
      const downloadResponse = await blobClient.download();

      // Crear un buffer para almacenar los datos
      const chunks: Buffer[] = [];

      // @ts-ignore - readableStreamBody existe pero TypeScript no lo reconoce correctamente
      for await (const chunk of downloadResponse.readableStreamBody) {
        // Asegurar que chunk se convierte correctamente a Buffer
        if (Buffer.isBuffer(chunk)) {
          chunks.push(chunk);
        } else if (typeof chunk === "string") {
          chunks.push(Buffer.from(chunk, "utf-8"));
        } else if (chunk && typeof chunk === "object") {
          // Verificamos si tiene buffer
          if ("buffer" in chunk) {
            const typedChunk = chunk as { buffer: ArrayBuffer };
            chunks.push(Buffer.from(typedChunk.buffer));
          }
          // Verificamos si es array-like
          else if ("length" in chunk) {
            const typedChunk = chunk as unknown as ArrayBuffer;
            chunks.push(Buffer.from(typedChunk));
          } else {
            // Para cualquier otro objeto, convertir a string
            chunks.push(Buffer.from(JSON.stringify(chunk)));
          }
        } else {
          // Último recurso para cualquier otro tipo
          chunks.push(Buffer.from(String(chunk)));
        }
      }

      // Combinar los chunks en un solo buffer
      const buffer = Buffer.concat(chunks);

      // Obtener los metadatos del blob
      const propertiesResponse = await blobClient.getProperties();

      return {
        buffer,
        metadata: propertiesResponse.metadata,
      };
    } catch (error: unknown) {
      this.logger.error(
        `Error al descargar documento desde ${storageUrl}:`,
        error
      );
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw createAppError(
        500,
        `Error al descargar documento: ${errorMessage}`
      );
    }
  }

  /**
   * Extrae texto de diferentes tipos de documentos
   */
  private async extractText(
    buffer: Buffer,
    contentType: string,
    fileName: string
  ): Promise<string> {
    try {
      switch (contentType) {
        case "application/pdf":
          return await this.extractTextFromPdf(buffer);

        case "text/plain":
          return buffer.toString("utf-8");

        case "text/markdown":
          return buffer.toString("utf-8");

        case "application/msword":
        case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
          return await this.extractTextFromWord(buffer);

        case "text/csv":
          return await this.extractTextFromCsv(buffer);

        case "application/json":
          return await this.extractTextFromJson(buffer);

        default:
          // Si el tipo de contenido no es reconocido, intentar inferir basado en la extensión
          if (fileName) {
            const extension = this.getFileExtension(fileName).toLowerCase();

            if (extension === ".pdf")
              return await this.extractTextFromPdf(buffer);
            if (extension === ".txt") return buffer.toString("utf-8");
            if (extension === ".md") return buffer.toString("utf-8");
            if (extension === ".doc" || extension === ".docx")
              return await this.extractTextFromWord(buffer);
            if (extension === ".csv")
              return await this.extractTextFromCsv(buffer);
            if (extension === ".json")
              return await this.extractTextFromJson(buffer);
          }

          // Si no se puede determinar, tratar como texto plano
          return buffer.toString("utf-8");
      }
    } catch (error: unknown) {
      this.logger.error(
        `Error al extraer texto de documento ${contentType}:`,
        error
      );
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw createAppError(422, `Error al extraer texto: ${errorMessage}`);
    }
  }

  /**
   * Extrae texto de un documento PDF
   */
  private async extractTextFromPdf(buffer: Buffer): Promise<string> {
    try {
      // Cargar el documento PDF
      const data = new Uint8Array(buffer);
      const loadingTask = pdfjs.getDocument(data);
      const pdf = await loadingTask.promise;

      let text = "";

      // Extraer texto de cada página
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();

        // Concatenar el texto de todos los elementos de la página
        const pageText = content.items.map((item: any) => item.str).join(" ");

        text += pageText + "\n\n";
      }

      return text;
    } catch (error: unknown) {
      this.logger.error("Error al extraer texto de PDF:", error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(`No se pudo extraer texto del PDF: ${errorMessage}`);
    }
  }

  /**
   * Extrae texto de un documento Word
   */
  private async extractTextFromWord(buffer: Buffer): Promise<string> {
    try {
      // Usar mammoth para convertir .docx a texto
      const result = await mammoth.extractRawText({ buffer });
      return result.value;
    } catch (error: unknown) {
      this.logger.error("Error al extraer texto de Word:", error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(
        `No se pudo extraer texto del documento Word: ${errorMessage}`
      );
    }
  }

  /**
   * Extrae texto de un archivo CSV
   */
  private async extractTextFromCsv(buffer: Buffer): Promise<string> {
    try {
      // Usar xlsx para leer el CSV
      const workbook = XLSX.read(buffer, { type: "buffer" });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];

      // Convertir a JSON
      const data = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });

      // Convertir a texto
      return data.map((row: any) => row.join(", ")).join("\n");
    } catch (error: unknown) {
      this.logger.error("Error al extraer texto de CSV:", error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(`No se pudo extraer texto del CSV: ${errorMessage}`);
    }
  }

  /**
   * Extrae texto de un archivo JSON
   */
  private async extractTextFromJson(buffer: Buffer): Promise<string> {
    try {
      const jsonString = buffer.toString("utf-8");
      const jsonData = JSON.parse(jsonString);

      // Si hay un campo específico de contenido, usarlo
      if (jsonData.content) {
        return jsonData.content;
      }

      // Si no, convertir todo el objeto a texto
      return JSON.stringify(jsonData, null, 2);
    } catch (error: unknown) {
      this.logger.error("Error al extraer texto de JSON:", error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(`No se pudo extraer texto del JSON: ${errorMessage}`);
    }
  }

  /**
   * Normaliza el texto para eliminar caracteres innecesarios
   */
  private normalizeText(text: string): string {
    return text
      .replace(/\r\n/g, "\n") // Normalizar saltos de línea
      .replace(/\t/g, " ") // Reemplazar tabulaciones con espacios
      .replace(/\n{3,}/g, "\n\n") // Reemplazar múltiples saltos de línea con máximo dos
      .replace(/ {2,}/g, " ") // Reemplazar múltiples espacios con uno solo
      .trim(); // Eliminar espacios al inicio y final
  }

  /**
   * Divide el texto en chunks con overlap
   */
  private splitIntoChunks(
    text: string,
    documentId: string,
    knowledgeBaseId: string
  ): DocumentChunk[] {
    const chunks: DocumentChunk[] = [];

    // Divide el texto en párrafos
    const paragraphs = text.split(/\n\s*\n/);

    let currentChunk = "";
    let position = 0;

    for (const paragraph of paragraphs) {
      // Si añadir este párrafo excedería el tamaño del chunk y ya hay contenido
      if (
        currentChunk.length + paragraph.length > this.chunkSize &&
        currentChunk.length > 0
      ) {
        // Guardar el chunk actual
        chunks.push({
          id: `${documentId}_chunk_${position}`,
          documentId,
          knowledgeBaseId,
          content: currentChunk.trim(),
          position,
          tokenCount: this.estimateTokenCount(currentChunk), // Estimación simplificada de tokens
        });

        // Iniciar un nuevo chunk con overlap
        const overlapStart = Math.max(
          0,
          currentChunk.length - this.chunkOverlap
        );
        currentChunk =
          currentChunk.substring(overlapStart) + "\n\n" + paragraph;
        position++;
      } else {
        // Añadir el párrafo al chunk actual
        currentChunk += (currentChunk ? "\n\n" : "") + paragraph;
      }
    }

    // Añadir el último chunk si tiene contenido
    if (currentChunk.trim().length > 0) {
      chunks.push({
        id: `${documentId}_chunk_${position}`,
        documentId,
        knowledgeBaseId,
        content: currentChunk.trim(),
        position,
        tokenCount: this.estimateTokenCount(currentChunk),
      });
    }

    return chunks;
  }

  /**
   * Estima el número de tokens basado en el número de palabras
   * (estimación simple: ~1.33 tokens por palabra)
   */
  private estimateTokenCount(text: string): number {
    const words = text.split(/\s+/).length;
    return Math.ceil(words * 1.33);
  }

  /**
   * Guarda los chunks procesados en Blob Storage
   */
  private async saveProcessedChunks(
    chunks: DocumentChunk[],
    documentId: string,
    knowledgeBaseId: string,
    agentId: string
  ): Promise<void> {
    try {
      const containerClient = this.storageService.getBlobContainerClient(
        BLOB_CONTAINERS.PROCESSED_DOCUMENTS
      );

      // Asegurar que el contenedor existe
      await containerClient.createIfNotExists();

      // Guardar cada chunk como un blob independiente
      for (const chunk of chunks) {
        const blobName = `${agentId}/${knowledgeBaseId}/${documentId}/${chunk.id}.txt`;
        const blockBlobClient = containerClient.getBlockBlobClient(blobName);

        await blockBlobClient.upload(chunk.content, chunk.content.length);
      }

      // Guardar también un archivo con metadatos
      const metadataBlobName = `${agentId}/${knowledgeBaseId}/${documentId}/metadata.json`;
      const metadataBlockBlobClient =
        containerClient.getBlockBlobClient(metadataBlobName);

      const metadata = {
        documentId,
        knowledgeBaseId,
        agentId,
        chunkCount: chunks.length,
        chunkSize: this.chunkSize,
        chunkOverlap: this.chunkOverlap,
        chunks: chunks.map((chunk) => ({
          id: chunk.id,
          position: chunk.position,
          tokenCount: chunk.tokenCount,
        })),
      };

      const metadataContent = JSON.stringify(metadata, null, 2);
      await metadataBlockBlobClient.upload(
        metadataContent,
        metadataContent.length
      );

      this.logger.debug(
        `Chunks guardados en Blob Storage para documento ${documentId}`
      );
    } catch (error: unknown) {
      this.logger.error(`Error al guardar chunks en Blob Storage:`, error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw createAppError(500, `Error al guardar chunks: ${errorMessage}`);
    }
  }

  /**
   * Encola chunks para generación de embeddings
   */
  private async queueChunksForEmbeddings(
    chunks: DocumentChunk[],
    documentId: string,
    knowledgeBaseId: string,
    agentId: string
  ): Promise<void> {
    try {
      const queueClient = this.storageService.getQueueClient(
        STORAGE_QUEUES.EMBEDDING
      );

      // Encolar cada chunk para procesar
      for (const chunk of chunks) {
        const message: EmbeddingQueueMessage = {
          chunkId: chunk.id,
          documentId,
          knowledgeBaseId,
          agentId,
          content: chunk.content,
          position: chunk.position,
        };

        await queueClient.sendMessage(
          Buffer.from(JSON.stringify(message)).toString("base64")
        );
      }

      this.logger.debug(
        `${chunks.length} chunks encolados para generación de embeddings`
      );
    } catch (error: unknown) {
      this.logger.error(`Error al encolar chunks para embeddings:`, error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw createAppError(500, `Error al encolar chunks: ${errorMessage}`);
    }
  }

  /**
   * Obtiene la extensión de un archivo
   */
  private getFileExtension(filename: string): string {
    const parts = filename.split(".");
    return parts.length > 1 ? `.${parts[parts.length - 1]}` : "";
  }
}
