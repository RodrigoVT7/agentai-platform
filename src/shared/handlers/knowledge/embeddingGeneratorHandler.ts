// src/shared/handlers/knowledge/embeddingGeneratorHandler.ts
import { StorageService } from "../../services/storage.service";
import { OpenAIService } from "../../services/openai.service";
import { STORAGE_TABLES, BLOB_CONTAINERS } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { DocumentProcessingStatus } from "../../models/document.model";
import { EmbeddingQueueMessage } from "../../models/documentProcessor.model";
import { EmbeddingResult, Vector } from "../../models/embedding.model";
import { AzureAiSearchService } from "../../services/azureAiSearch.service";
import { SearchClient } from "@azure/search-documents";
import { ChunkStructure } from "../../models/document-analysis.model";
import { TextAnalysisUtils } from "../../utils/text-analysis.utils";

export class EmbeddingGeneratorHandler {
  private storageService: StorageService;
  private openaiService: OpenAIService;
  private aiSearchService: AzureAiSearchService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.logger = logger || createLogger();
    this.storageService = new StorageService();
    this.openaiService = new OpenAIService(this.logger);
    this.aiSearchService = new AzureAiSearchService(this.logger);
  }
  
 /**
   * Procesa un mensaje de la cola y genera embeddings
   */

public async execute(message: EmbeddingQueueMessage): Promise<EmbeddingResult> {
  const { chunkId, documentId, knowledgeBaseId, content, agentId } = message;
  
  try {
    // Validación más flexible - permitir content vacío
    if (!message || !message.chunkId || !message.documentId || !message.knowledgeBaseId) {
      this.logger.error("Mensaje de cola inválido - faltan campos requeridos", { message });
      return {
        chunkId: message?.chunkId || 'unknown',
        documentId: message?.documentId || 'unknown',
        knowledgeBaseId: message?.knowledgeBaseId || 'unknown',
        success: false,
        error: 'Mensaje de cola inválido'
      };
    }
    
    this.logger.info(`Generando embedding para chunk ${chunkId} del documento ${documentId}`);
    
    // Si el contenido está vacío, usar un placeholder
    const contentToEmbed = content && content.trim() ? content : '[Contenido vacío]';
    
    // Generar embedding
    const vector = await this.openaiService.getEmbedding(contentToEmbed);
    
    if (!vector || vector.length === 0) {
      throw createAppError(500, `Error al generar embedding para chunk ${chunkId}`);
    }
    
    // Indexar en AI Search (guardar el content original, no el placeholder)
    await this.indexVectorInAiSearch(chunkId, documentId, knowledgeBaseId, vector, content || '');
    
    // Comprobar si todos los chunks tienen embedding
    await this.checkDocumentCompletion(documentId, knowledgeBaseId, agentId);
    
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
    
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      chunkId,
      documentId,
      knowledgeBaseId,
      success: false,
      error: errorMessage || 'Error desconocido al generar embedding'
    };
  }
}
  
    /**
     * Comprueba si todos los chunks de un documento han sido indexados en AI Search
     * y actualiza el estado del documento si es así.
     */
    private async checkDocumentCompletion(documentId: string, knowledgeBaseId: string, agentId: string): Promise<void> {
        let totalChunksExpected = 0;
        let currentIndexedCount = 0;
        let currentDocStatus: DocumentProcessingStatus | undefined;
        const docTableClient = this.storageService.getTableClient(STORAGE_TABLES.DOCUMENTS);
  
        try {
            // --- Obtener estado actual del documento ---
            try {
                 const currentDoc = await docTableClient.getEntity(knowledgeBaseId, documentId);
                 currentDocStatus = currentDoc.processingStatus as DocumentProcessingStatus;
  
                 // Si ya está vectorizado, no hacer nada más.
                 if (currentDocStatus === DocumentProcessingStatus.VECTORIZED) {
                     this.logger.debug(`Documento ${documentId} ya está marcado como VECTORIZED. Saltando verificación.`);
                     return;
                 }
                  // Si está fallido, tampoco intentar actualizar (requiere reproceso manual)
                 if (currentDocStatus === DocumentProcessingStatus.FAILED) {
                      this.logger.debug(`Documento ${documentId} está en estado FAILED. Saltando verificación.`);
                      return;
                 }
  
            } catch (error: any) {
                  // Si no se encuentra el documento en la tabla, no podemos verificar. Log y salir.
                 if (error.statusCode === 404) {
                     this.logger.warn(`No se encontró el documento ${documentId} en Table Storage para verificar completitud.`);
                     return;
                 }
                 // Otros errores al obtener el documento
                 this.logger.error(`Error al obtener estado actual del documento ${documentId} antes de verificar:`, error);
                 return; // No continuar si no podemos obtener el estado actual
            }
  
  
            // --- Obtener total de chunks esperados ---
            try {
                const containerClient = this.storageService.getBlobContainerClient(BLOB_CONTAINERS.PROCESSED_DOCUMENTS);
                const metadataBlobClient = containerClient.getBlobClient(`${agentId}/${knowledgeBaseId}/${documentId}/metadata.json`);
  
                if (await metadataBlobClient.exists()) {
                    const downloadResponse = await metadataBlobClient.download();
                    const metadataText = await this.streamToString(downloadResponse.readableStreamBody);
                    const metadata = JSON.parse(metadataText);
                    totalChunksExpected = metadata.chunkCount || 0;

                    let attempts = 0;
                    const maxAttempts = 3;
                    const retryDelay = 1000;

                    while (attempts < maxAttempts) {
                        try {
                            const searchClient: SearchClient<any> = this.aiSearchService.getSearchClient();
                            const searchResults = await searchClient.search("*", {
                                filter: `documentId eq '${documentId}'`,
                                includeTotalCount: true,
                                top: 0
                            });
                            currentIndexedCount = searchResults.count ?? 0;
                            this.logger.debug(`Documento ${documentId}: Intento ${attempts + 1}: ${currentIndexedCount} chunks encontrados (Esperados: ${totalChunksExpected}).`);
                
                            // Si el conteo es suficiente O si ya no hay más reintentos, salir del bucle
                            if (currentIndexedCount >= totalChunksExpected || attempts === maxAttempts - 1) {
                                 break;
                            }
                
                            // Esperar antes del siguiente intento
                            attempts++;
                            await new Promise(resolve => setTimeout(resolve, retryDelay));
                
                        } catch (error) {
                            this.logger.error(`Intento ${attempts + 1}: Error al contar chunks indexados para ${documentId}:`, error);
                            // Si falla la consulta, probablemente no tenga sentido reintentar inmediatamente
                            // Considerar salir del bucle o manejar el error de forma diferente
                             break; // Salir del bucle en caso de error en la consulta
                        }
                    }

                    
                    this.logger.debug(`Documento ${documentId}: Se esperan ${totalChunksExpected} chunks según metadata.json.`);
                } else {
                    this.logger.warn(`No se encontró metadata.json para el documento ${documentId}. No se puede verificar la completitud.`);
                    return;
                }
            } catch (error) {
                 this.logger.error(`Error al leer metadata.json para ${documentId}:`, error);
                 // Marcar como FAILED si no podemos leer metadatos esenciales
                 await this.updateDocumentStatus(documentId, knowledgeBaseId, DocumentProcessingStatus.FAILED, `Error leyendo metadata.json: ${error instanceof Error ? error.message : String(error)}`);
                 return;
            }
  
            if (totalChunksExpected === 0) {
                this.logger.warn(`El documento ${documentId} no tiene chunks esperados según metadata.json. Marcando como fallido.`);
                await this.updateDocumentStatus(documentId, knowledgeBaseId, DocumentProcessingStatus.FAILED, "Documento sin chunks procesados según metadata.");
                return;
            }
  
            // --- Contar chunks indexados en Azure AI Search ---
            try {
                // Opcional: Añadir un pequeño retraso aquí si la latencia es un problema persistente
                // await new Promise(resolve => setTimeout(resolve, 500)); // Esperar 500ms
  
                const searchClient: SearchClient<any> = this.aiSearchService.getSearchClient();
                const searchResults = await searchClient.search("*", {
                    filter: `documentId eq '${documentId}'`,
                    includeTotalCount: true,
                    top: 0
                });
                currentIndexedCount = searchResults.count ?? 0;
                this.logger.debug(`Documento ${documentId}: ${currentIndexedCount} chunks encontrados en Azure AI Search (Esperados: ${totalChunksExpected}).`);
            } catch (error) {
                this.logger.error(`Error al contar chunks indexados en Azure AI Search para ${documentId}:`, error);
                // No actualizar estado si no podemos contar
                return;
            }
  
  
            // --- Comparar y actualizar estado si es necesario ---
             if (currentIndexedCount >= totalChunksExpected) {
    await this.updateDocumentStatus(documentId, knowledgeBaseId, DocumentProcessingStatus.VECTORIZED);
    this.logger.info(`Documento ${documentId} completamente vectorizado (${currentIndexedCount}/${totalChunksExpected}). Estado actualizado.`);
  } else if (currentIndexedCount >= totalChunksExpected * 0.9) {
    // Si tenemos al menos 90% de los chunks, considerarlo completo
    this.logger.warn(`Documento ${documentId} tiene ${currentIndexedCount}/${totalChunksExpected} chunks (${Math.round(currentIndexedCount/totalChunksExpected*100)}%). Marcando como vectorizado.`);
    await this.updateDocumentStatus(documentId, knowledgeBaseId, DocumentProcessingStatus.VECTORIZED);
  } else {
    this.logger.info(`Documento ${documentId} aún no está completamente vectorizado (${currentIndexedCount}/${totalChunksExpected}).`);
  }
        } catch (error) {
            this.logger.error(`Error general en checkDocumentCompletion para ${documentId}:`, error);
            // No propagamos el error para no detener el proceso de otros chunks
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
        const tableClient = this.storageService.getTableClient(STORAGE_TABLES.DOCUMENTS);
        const updateEntity: any = {
            partitionKey: knowledgeBaseId,
            rowKey: documentId,
            processingStatus: status,
            updatedAt: Date.now()
        };

        // Limpiar error si el estado no es FAILED
        if (status !== DocumentProcessingStatus.FAILED) {
            updateEntity.processingError = null; // o eliminar el campo si es posible
        }
        // Añadir error si el estado es FAILED
        else if (error) {
            const errorMessage = error instanceof Error
                ? error.message
                : typeof error === 'object' && error !== null && 'message' in error
                  ? String((error as { message: unknown }).message)
                  : String(error);
            updateEntity.processingError = errorMessage.substring(0, 1024); // Limitar longitud
        }

        await tableClient.updateEntity(updateEntity, "Merge");
        this.logger.debug(`Estado del documento ${documentId} actualizado a ${status}`);
    } catch (updateError: any) {
        // Evitar error si el documento ya no existe (podría haber sido eliminado)
        if (updateError.statusCode !== 404) {
            this.logger.error(`Error al actualizar estado del documento ${documentId} a ${status}:`, updateError);
        }
    }
}

  /**
        * Función auxiliar para convertir stream a string
        */
  private async streamToString(readableStream: NodeJS.ReadableStream | undefined): Promise<string> {
    if (!readableStream) return '';

    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        readableStream.on('data', (data) => {
            chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
        });
        readableStream.on('end', () => {
            resolve(Buffer.concat(chunks).toString('utf8'));
        });
        readableStream.on('error', reject);
    });
  }


// Añadir estos métodos a la clase:

private async enrichContentForEmbedding(
  content: string, 
  message: EmbeddingQueueMessage
): Promise<string> {
  let enriched = content;
  
  // Analizar la estructura del chunk
  const structure = this.analyzeChunkStructure(content);
  
  // Añadir contexto basado en la estructura detectada
  const contextPrefixes: string[] = [];
  
  if (structure.isStructured) {
    contextPrefixes.push(`[Estructura: ${structure.type}]`);
  }
  
  // **NUEVO: Marcar contenido crítico para comparaciones**
  if (structure.isComparisonCritical) {
    contextPrefixes.push('[DATOS COMPARABLES - CRÍTICO PARA RANKINGS/EXTREMOS]');
  }
  
  if (structure.hasNumericValues) {
    contextPrefixes.push('[Contiene valores numéricos]');
    
    // Si hay comparaciones posibles, indicarlo
    if (structure.hasComparisons || this.detectComparativePotential(content)) {
      contextPrefixes.push('[Datos comparables]');
    }
  }
  
  // Detectar el tipo de contenido sin hardcodear
  const contentType = await this.inferDocumentType(content);
  if (contentType && contentType !== 'general') {
    contextPrefixes.push(`[Contenido: ${contentType}]`);
  }
  
  // **NUEVO: Para datos críticos, añadir instrucciones específicas**
  if (structure.isComparisonCritical) {
    contextPrefixes.push('[INSTRUCCIÓN: Este chunk contiene datos que pueden ser comparados. Ideal para consultas de máximo/mínimo/mejor/peor]');
  }
  
  // Construir el contenido enriquecido
  if (contextPrefixes.length > 0) {
    enriched = contextPrefixes.join(' ') + '\n\n' + content;
  }
  
  return enriched;
}

private analyzeChunkStructure(content: string): ChunkStructure {
  const lines = content.split('\n').filter(l => l.trim());
  
  const structure: ChunkStructure = {
    isStructured: false,
    type: 'text',
    hasNumericValues: false,
    hasComparisons: false,
    columnCount: 0,
    patternConsistency: 0,
    isComparisonCritical: false // **NUEVO CAMPO**
  };
  
  if (lines.length === 0) return structure;
  
  // Detectar valores numéricos
  const numbers = TextAnalysisUtils.extractNumbers(content);
  structure.hasNumericValues = numbers.length > 0;
  
  // **NUEVO: Detectar si es dato crítico para comparaciones**
  structure.isComparisonCritical = this.isComparisonCriticalContent(content);
  
  // Detectar comparaciones
  const comparisonPatterns = [
    /(?:más|menos|mayor|menor|mejor|peor)/i,
    /(?:máximo|mínimo|óptimo|ideal)/i,
    /(?:comparar|versus|vs|entre)/i,
    /(?:superior|inferior|igual)/i,
    /(?:aumenta|disminuye|crece|reduce)/i
  ];
  
  structure.hasComparisons = comparisonPatterns.some(pattern => pattern.test(content));
  
  // Analizar estructura de líneas
  const lineFormats = lines.map(line => TextAnalysisUtils.getLineFormat(line));
  
  // Detectar si es estructurado
  const separatorLines = lineFormats.filter(f => f.hasSeparator).length;
  const avgColumns = lineFormats
    .filter(f => f.hasSeparator)
    .reduce((sum, f) => sum + f.columnCount, 0) / (separatorLines || 1);
  
  if (separatorLines > lines.length * 0.5) {
    structure.isStructured = true;
    structure.columnCount = Math.round(avgColumns);
    structure.patternConsistency = separatorLines / lines.length;
    
    if (structure.columnCount > 1) {
      structure.type = 'tabular';
    } else if (this.detectKeyValuePattern(lines)) {
      structure.type = 'key-value';
    } else {
      structure.type = 'structured-list';
    }
  } else if (this.detectListPattern(lines)) {
    structure.isStructured = true;
    structure.type = 'list';
    structure.patternConsistency = 0.7;
  }
  
  return structure;
}

// 4. MÉTODO AUXILIAR: Detectar contenido crítico para comparaciones
private isComparisonCriticalContent(content: string): boolean {
  // Reutilizar la lógica del método anterior pero adaptada para contenido de chunk
  const contentLower = content.toLowerCase();
  
  const comparisonKeywords = [
    'precio', 'price', 'cost', 'costo', '$', 'total', 'lista',
    'unidad', 'producto', 'modelo', 'ranking', 'score', 'nivel',
    'id', 'código', 'ref', 'm²', 'm2'
  ];
  
  const matchCount = comparisonKeywords.filter(keyword => contentLower.includes(keyword)).length;
  const numbers = TextAnalysisUtils.extractNumbers(content);
  
  return matchCount >= 2 && numbers.length >= 3;
}



private detectComparativePotential(content: string): boolean {
  // Detectar si el contenido tiene potencial para comparaciones
  const lines = content.split('\n');
  const numbers = TextAnalysisUtils.extractNumbers(content);
  
  // Si hay múltiples números, probablemente se pueden comparar
  if (numbers.length > 2) return true;
  
  // Si hay múltiples items con el mismo formato
  const patterns: Map<string, number> = new Map();
  
  lines.forEach(line => {
    const format = this.getLinePattern(line);
    if (format) {
      patterns.set(format, (patterns.get(format) || 0) + 1);
    }
  });
  
  // Si hay patrones repetidos, sugiere items comparables
  return Array.from(patterns.values()).some(count => count > 2);
}

private getLinePattern(line: string): string | null {
  // Detectar el patrón de una línea para identificar items similares
  const trimmed = line.trim();
  
  if (!trimmed) return null;
  
  // Reemplazar números y valores específicos con marcadores
  let pattern = trimmed
    .replace(/\d+([.,]\d+)?/g, 'NUM')
    .replace(/\$\s*NUM/g, '$NUM')
    .replace(/NUM\s*%/g, 'NUM%')
    .replace(/"[^"]+"/g, 'TEXT')
    .replace(/'[^']+'/g, 'TEXT');
  
  // Si el patrón es muy genérico, no es útil
  if (pattern === 'NUM' || pattern === 'TEXT') return null;
  
  return pattern;
}

private detectKeyValuePattern(lines: string[]): boolean {
  const kvCount = lines.filter(line => TextAnalysisUtils.looksLikeKey(line)).length;
  return kvCount > lines.length * 0.5;
}

private detectListPattern(lines: string[]): boolean {
  const listPatterns = [
    /^\s*\d+[\.\)]\s+/,
    /^\s*[a-zA-Z][\.\)]\s+/,
    /^\s*[-*•]\s+/
  ];
  
  const listCount = lines.filter(line => 
    listPatterns.some(pattern => pattern.test(line))
  ).length;
  
  return listCount > lines.length * 0.4;
}

private async inferDocumentType(content: string): Promise<string> {
  // Inferir tipo de documento basado en el contenido sin hardcodear
  const contentLower = content.toLowerCase();
  
  // Buscar indicadores de tipo
  const typeIndicators = {
    financial: {
      keywords: ['precio', 'costo', 'valor', 'total', 'subtotal', 'impuesto', 'descuento', '$', 'usd', 'mxn', 'eur'],
      weight: 0
    },
    medical: {
      keywords: ['paciente', 'diagnóstico', 'tratamiento', 'síntoma', 'medicamento', 'dosis', 'mg', 'ml', 'resultados'],
      weight: 0
    },
    legal: {
      keywords: ['artículo', 'sección', 'cláusula', 'contrato', 'ley', 'decreto', 'párrafo', 'inciso', 'fracción'],
      weight: 0
    },
    technical: {
      keywords: ['sistema', 'proceso', 'método', 'función', 'parámetro', 'configuración', 'algoritmo', 'datos'],
      weight: 0
    },
    inventory: {
      keywords: ['producto', 'stock', 'inventario', 'cantidad', 'unidades', 'disponible', 'agotado', 'existencias'],
      weight: 0
    },
    temporal: {
      keywords: ['fecha', 'hora', 'día', 'mes', 'año', 'calendario', 'horario', 'agenda', 'cita'],
      weight: 0
    }
  };
  
  // Calcular pesos basados en frecuencia de keywords
  Object.entries(typeIndicators).forEach(([type, config]) => {
    config.keywords.forEach(keyword => {
      if (contentLower.includes(keyword)) {
        config.weight++;
      }
    });
  });
  
  // Encontrar el tipo con mayor peso
  let maxWeight = 0;
  let detectedType = 'general';
  
  Object.entries(typeIndicators).forEach(([type, config]) => {
    if (config.weight > maxWeight) {
      maxWeight = config.weight;
      detectedType = type;
    }
  });
  
  // Solo asignar tipo si hay suficiente confianza
  return maxWeight > 2 ? detectedType : 'general';
}

private detectNumericData(content: string): boolean {
  const numbers = TextAnalysisUtils.extractNumbers(content);
  return numbers.length > 0;
}

// Modificar el método indexVectorInAiSearch para incluir metadata enriquecida
private async indexVectorInAiSearch(
  chunkId: string,
  documentId: string,
  knowledgeBaseId: string,
  vector: number[],
  content: string,
  chunkOwnMetadata?: Record<string, any>
): Promise<void> {
  try {
    const adminClient = this.aiSearchService.getAdminClient();
    
    // Preparar documento para indexar
    const documentToUpload: Record<string, any> = {
      chunkId: chunkId,
      documentId: documentId,
      knowledgeBaseId: knowledgeBaseId,
      content: content,
      vector: vector,
      blockType: chunkOwnMetadata?.blockType,
      isPriceTable: chunkOwnMetadata?.isPriceTable, // Ejemplo
      isComparisonCritical: chunkOwnMetadata?.isComparisonCritical,
    };
    
    for (const key in documentToUpload) {
      if (documentToUpload[key] === undefined) {
        delete documentToUpload[key];
      }
    }

    const result = await adminClient.mergeOrUploadDocuments([documentToUpload]);
    
    if (result.results?.length > 0 && result.results[0].succeeded) {
      this.logger.debug(`Chunk ${chunkId} indexado en Azure AI Search con metadata enriquecida`);
    } else {
      const errorDetails = result.results?.length > 0 ? result.results[0].errorMessage : "Error desconocido";
      throw new Error(`Fallo al indexar chunk ${chunkId}: ${errorDetails}`);
    }
  } catch (error) {
    this.logger.error(`Error al indexar vector en Azure AI Search para chunk ${chunkId}:`, error);
    throw error;
  }
}

}