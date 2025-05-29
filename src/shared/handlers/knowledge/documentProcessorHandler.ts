// src/shared/handlers/knowledge/documentProcessorHandler.ts
import { v4 as uuidv4 } from "uuid";
import { BlobServiceClient } from "@azure/storage-blob";
import { TableClient } from "@azure/data-tables";
import * as pdfjs from 'pdfjs-dist';
import * as XLSX from 'xlsx';
import * as mammoth from 'mammoth';
import { 
  DocumentStructureAnalysis, 
  StructurePattern, 
  SemanticBlock, 
  LineFormat 
} from "../../models/document-analysis.model";
import { TextAnalysisUtils } from "../../utils/text-analysis.utils";

import { StorageService } from "../../services/storage.service";
import { BLOB_CONTAINERS, STORAGE_TABLES, STORAGE_QUEUES, EMBEDDING_CONFIG } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { 
  DocumentProcessingStatus, 
  DocumentProcessingQueueMessage 
} from "../../models/document.model";
import { 
  DocumentChunk, 
  ProcessingResult, 
  EmbeddingQueueMessage 
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
  public async execute(message: DocumentProcessingQueueMessage): Promise<ProcessingResult> {
    const { documentId, knowledgeBaseId, agentId, storageUrl } = message;
    
    try {
      this.logger.info(`Iniciando procesamiento del documento ${documentId} para base de conocimiento ${knowledgeBaseId}`);
      
      // Actualizar estado del documento a 'processing'
      await this.updateDocumentStatus(documentId, knowledgeBaseId, DocumentProcessingStatus.PROCESSING);
      
      // Descargar el documento desde Blob Storage
      const documentContent = await this.downloadDocument(storageUrl);
      
      if (!documentContent || !documentContent.buffer) {
        throw createAppError(500, `No se pudo descargar el documento ${documentId}`);
      }
      
      // Extraer texto según el tipo de documento
      let extractedText = await this.extractText(documentContent.buffer, message.contentType, message.originalName);
      
      if (!extractedText || extractedText.trim() === '') {
        throw createAppError(422, `No se pudo extraer texto del documento ${documentId}`);
      }
      
      // Normalizar el texto extraído
      extractedText = this.normalizeText(extractedText);
      
      // Dividir en chunks
      const chunks = this.splitIntoChunks(extractedText, documentId, knowledgeBaseId);
      
      if (chunks.length === 0) {
        throw createAppError(422, `No se pudieron crear chunks para el documento ${documentId}`);
      }
      
      // Guardar los chunks procesados en Blob Storage
      await this.saveProcessedChunks(chunks, documentId, knowledgeBaseId, agentId);
      
      // Actualizar estado del documento a 'processed'
      await this.updateDocumentStatus(documentId, knowledgeBaseId, DocumentProcessingStatus.PROCESSED);
      
      // Encolar chunks para generación de embeddings
      await this.queueChunksForEmbeddings(chunks, documentId, knowledgeBaseId, agentId);
      
      this.logger.info(`Documento ${documentId} procesado con éxito. Se generaron ${chunks.length} chunks`);
      
      return {
        documentId,
        knowledgeBaseId,
        status: DocumentProcessingStatus.PROCESSED,
        chunks
      };
    } catch (error: unknown) {
      this.logger.error(`Error al procesar documento ${documentId}:`, error);
      
      // Actualizar estado del documento a 'failed'
      await this.updateDocumentStatus(documentId, knowledgeBaseId, DocumentProcessingStatus.FAILED, error);
      
      // Verificar si es un AppError
      if (error && typeof error === 'object' && 'statusCode' in error) {
        throw error;
      }
      
      // Crear un mensaje de error genérico
      const errorMessage = error instanceof Error ? error.message : String(error);
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
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.DOCUMENTS);
      
      const updateEntity: any = {
        partitionKey: knowledgeBaseId,
        rowKey: documentId,
        processingStatus: status,
        updatedAt: Date.now()
      };
      
      if (error) {
        // Asegurar que error.message sea un string
        const errorMessage = error instanceof Error 
          ? error.message 
          : typeof error === 'object' && error !== null && 'message' in error
            ? String((error as { message: unknown }).message)
            : String(error);
        
        updateEntity.processingError = errorMessage;
      }
      
      await tableClient.updateEntity(updateEntity, "Merge");
      
      this.logger.debug(`Estado del documento ${documentId} actualizado a ${status}`);
    } catch (error) {
      this.logger.error(`Error al actualizar estado del documento ${documentId}:`, error);
      // No relanzamos el error para no interrumpir el flujo principal
    }
  }
  
  /**
   * Descarga un documento desde Blob Storage
   */
  private async downloadDocument(storageUrl: string): Promise<{ buffer: Buffer, metadata?: any }> {
    try {
      // Extraer el nombre del contenedor y el blob de la URL
      const url = new URL(storageUrl);
      const pathParts = url.pathname.split('/');
      const containerName = pathParts[1]; // primer parte después de la primera /
      const blobName = pathParts.slice(2).join('/'); // el resto del path
      
      const containerClient = this.storageService.getBlobContainerClient(containerName);
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
        } else if (typeof chunk === 'string') {
          chunks.push(Buffer.from(chunk, 'utf-8'));
        } else if (chunk && typeof chunk === 'object') {
          // Verificamos si tiene buffer
          if ('buffer' in chunk) {
            const typedChunk = chunk as { buffer: ArrayBuffer };
            chunks.push(Buffer.from(typedChunk.buffer));
          }
          // Verificamos si es array-like
          else if ('length' in chunk) {
            const typedChunk = chunk as unknown as ArrayBuffer;
            chunks.push(Buffer.from(typedChunk));
          }
          else {
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
        metadata: propertiesResponse.metadata
      };
    } catch (error: unknown) {
      this.logger.error(`Error al descargar documento desde ${storageUrl}:`, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw createAppError(500, `Error al descargar documento: ${errorMessage}`);
    }
  }
  
  /**
   * Extrae texto de diferentes tipos de documentos
   */

// Reemplazar el método extractText existente con:
private async extractText(buffer: Buffer, contentType: string, fileName: string): Promise<string> {
  try {
    // Primero extraer el texto crudo según el tipo
    let rawText = '';
    
    switch (contentType) {
      case 'application/pdf':
        rawText = await this.extractTextFromPdfWithStructure(buffer);
        break;
      case 'text/plain':
      case 'text/markdown':
        rawText = buffer.toString('utf-8');
        break;
      case 'application/msword':
      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        rawText = await this.extractTextFromWord(buffer);
        break;
      case 'text/csv':
        rawText = await this.extractTextFromCsvWithHeaders(buffer);
        break;
      case 'application/json':
        rawText = await this.extractTextFromJson(buffer);
        break;
      default:
        // Intentar detectar por extensión
        if (fileName) {
          const extension = this.getFileExtension(fileName).toLowerCase();
          switch (extension) {
            case '.pdf':
              rawText = await this.extractTextFromPdfWithStructure(buffer);
              break;
            case '.csv':
              rawText = await this.extractTextFromCsvWithHeaders(buffer);
              break;
            default:
              rawText = buffer.toString('utf-8');
          }
        } else {
          rawText = buffer.toString('utf-8');
        }
    }
    
    // Analizar y preservar estructura si existe
    const structureAnalysis = await this.analyzeDocumentStructure(rawText);
    
    if (structureAnalysis.hasStructure) {
      return this.preserveStructure(rawText, structureAnalysis);
    }
    
    return this.normalizeText(rawText);
  } catch (error) {
    this.logger.error(`Error al extraer texto de documento ${contentType}:`, error);
    throw error;
  }
}

// Nuevo método para PDFs con preservación de estructura
private async extractTextFromPdfWithStructure(buffer: Buffer): Promise<string> {
  try {
    const data = new Uint8Array(buffer);
    const loadingTask = pdfjs.getDocument(data);
    const pdf = await loadingTask.promise;
    
    let structuredText = '';
    
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      
      // Reconstruir estructura de la página
      const pageStructure = this.reconstructPageStructure(content.items);
      
      if (pageNum > 1) {
        structuredText += '\n\n--- Nueva Página ---\n\n';
      }
      
      structuredText += pageStructure;
    }
    
    if (/* Lógica para identificar si el buffer/fileName corresponde a la lista de precios, ej. fileName.includes('Lista Precios') */ true) { // Quita el 'true' y pon una condición real
    this.logger.info(`Texto extraído (primeros 500 chars) de Lista de Precios: ${structuredText.substring(0, 500)}`);
    }
    return structuredText;

  } catch (error) {
    this.logger.error('Error al extraer texto estructurado de PDF:', error);
    throw error;
  }
}

// Reconstruir la estructura de una página PDF
private reconstructPageStructure(items: any[]): string {
  if (!items || items.length === 0) return '';
  
  // Agrupar items por posición Y (filas)
  const rows = new Map<number, any[]>();
  
  items.forEach(item => {
    // Redondear Y para agrupar elementos en la misma línea
    const y = Math.round(item.transform[5] / 5) * 5;
    if (!rows.has(y)) {
      rows.set(y, []);
    }
    rows.get(y)!.push(item);
  });
  
  // Ordenar filas de arriba a abajo
  const sortedRows = Array.from(rows.entries())
    .sort((a, b) => b[0] - a[0]); // Y decrece de arriba a abajo en PDF
  
  let structuredText = '';
  let previousY = null;
  
  for (const [y, rowItems] of sortedRows) {
    // Detectar saltos grandes (posibles cambios de sección)
    if (previousY !== null && Math.abs(previousY - y) > 20) {
      structuredText += '\n';
    }
    
    // Ordenar items en la fila por posición X
    rowItems.sort((a, b) => a.transform[4] - b.transform[4]);
    
    // Detectar si es una tabla por la distribución de elementos
    const xPositions = rowItems.map(item => item.transform[4]);
    const gaps = [];
    for (let i = 1; i < xPositions.length; i++) {
      gaps.push(xPositions[i] - xPositions[i-1]);
    }
    
    // Si hay gaps consistentes, probablemente es una tabla
    const avgGap = gaps.length > 0 ? gaps.reduce((a, b) => a + b) / gaps.length : 0;
    const isTabular = gaps.length > 1 && gaps.every(gap => Math.abs(gap - avgGap) < avgGap * 0.3);
    
    // Construir el texto de la fila
    if (isTabular) {
      // Usar tabuladores para separar columnas
      structuredText += rowItems.map(item => item.str.trim()).join('\t') + '\n';
    } else {
      // Concatenar con espacios apropiados
      let rowText = '';
      for (let i = 0; i < rowItems.length; i++) {
        if (i > 0) {
          const gap = rowItems[i].transform[4] - (rowItems[i-1].transform[4] + rowItems[i-1].width);
          rowText += gap > 10 ? '  ' : ' ';
        }
        rowText += rowItems[i].str;
      }
      structuredText += rowText + '\n';
    }
    
    previousY = y;
  }
  
  return structuredText.trim();
}

// Mejorar extracción de CSV preservando headers
private async extractTextFromCsvWithHeaders(buffer: Buffer): Promise<string> {
  try {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    
    // Obtener rango de celdas
    const range = XLSX.utils.decode_range(firstSheet['!ref'] || 'A1');
    
    let structuredText = '[DATOS TABULARES CSV]\n';
    let headers: string[] = [];
    
    // Extraer headers (primera fila)
    for (let col = range.s.c; col <= range.e.c; col++) {
      const cellAddress = XLSX.utils.encode_cell({ r: range.s.r, c: col });
      const cell = firstSheet[cellAddress];
      headers.push(cell ? String(cell.v).trim() : `Columna${col + 1}`);
    }
    
    structuredText += headers.join('\t') + '\n';
    structuredText += headers.map(() => '---').join('\t') + '\n';
    
    // Extraer datos
    for (let row = range.s.r + 1; row <= range.e.r; row++) {
      const rowData: string[] = [];
      for (let col = range.s.c; col <= range.e.c; col++) {
        const cellAddress = XLSX.utils.encode_cell({ r: row, c: col });
        const cell = firstSheet[cellAddress];
        rowData.push(cell ? String(cell.v) : '');
      }
      
      // Solo añadir filas no vacías
      if (rowData.some(cell => cell.trim() !== '')) {
        structuredText += rowData.join('\t') + '\n';
      }
    }
    
    return structuredText;
  } catch (error) {
    this.logger.error('Error al extraer texto de CSV con estructura:', error);
    // Fallback al método anterior
    return await this.extractTextFromCsv(buffer);
  }
}

// Nuevo método para analizar estructura del documento
private async analyzeDocumentStructure(text: string): Promise<DocumentStructureAnalysis> {
  const lines = text.split('\n').filter(line => line.trim().length > 0);
  
  const analysis: DocumentStructureAnalysis = {
    hasStructure: false,
    patterns: [],
    structureType: 'unstructured',
    confidence: 0
  };
  
  if (lines.length === 0) return analysis;
  
  // 1. Detectar separadores consistentes
  const separatorAnalysis = this.analyzeSeparators(lines);
  if (separatorAnalysis.pattern) {
    analysis.patterns.push(separatorAnalysis.pattern);
    analysis.hasStructure = true;
  }
  
  // 2. Detectar listas
  const listAnalysis = this.analyzeLists(lines);
  if (listAnalysis.pattern) {
    analysis.patterns.push(listAnalysis.pattern);
    analysis.hasStructure = true;
  }
  
  // 3. Detectar pares clave-valor
  const kvAnalysis = this.analyzeKeyValuePairs(lines);
  if (kvAnalysis.pattern) {
    analysis.patterns.push(kvAnalysis.pattern);
    analysis.hasStructure = true;
  }
  
  // 4. Detectar estructura de tabla
  const tableAnalysis = this.analyzeTableStructure(lines);
  if (tableAnalysis.isTable) {
    analysis.hasStructure = true;
    analysis.structureType = 'tabular';
    analysis.confidence = tableAnalysis.confidence;
  }
  
  // Determinar el tipo dominante de estructura
  if (analysis.hasStructure) {
    if (analysis.patterns.length > 1) {
      analysis.structureType = 'mixed';
    } else if (separatorAnalysis.pattern && separatorAnalysis.pattern.confidence > 0.7) {
      analysis.structureType = 'tabular';
    } else if (listAnalysis.pattern && listAnalysis.pattern.confidence > 0.5) {
      analysis.structureType = 'list';
    } else if (kvAnalysis.pattern && kvAnalysis.pattern.confidence > 0.5) {
      analysis.structureType = 'key-value';
    }
    
    // Calcular confianza general
    analysis.confidence = Math.max(...analysis.patterns.map(p => p.confidence));
  }
  
  return analysis;
}

// Analizar separadores en el documento
private analyzeSeparators(lines: string[]): { pattern: StructurePattern | null } {
  const separatorTypes = [
    { name: 'tab', regex: /\t/, minOccurrence: 0.3 },
    { name: 'pipe', regex: /\|/, minOccurrence: 0.3 },
    { name: 'comma', regex: /,/, minOccurrence: 0.5 },
    { name: 'multispace', regex: /\s{2,}/, minOccurrence: 0.3 }
  ];
  
  for (const sepType of separatorTypes) {
    let count = 0;
    let totalSeparators = 0;
    
    lines.forEach(line => {
      const matches = line.match(new RegExp(sepType.regex, 'g'));
      if (matches && matches.length > 1) {
        count++;
        totalSeparators += matches.length;
      }
    });
    
    const occurrence = count / lines.length;
    
    if (occurrence >= sepType.minOccurrence) {
      return {
        pattern: {
          type: 'separator',
          value: sepType.name,
          confidence: occurrence,
          metadata: {
            averageSeparatorsPerLine: totalSeparators / count
          }
        }
      };
    }
  }
  
  return { pattern: null };
}

// Analizar patrones de lista
private analyzeLists(lines: string[]): { pattern: StructurePattern | null } {
  const listPatterns = [
    { name: 'numbered', regex: /^\s*\d+[\.\)]\s+/ },
    { name: 'lettered', regex: /^\s*[a-z][\.\)]\s+/i },
    { name: 'bulleted', regex: /^\s*[-*•]\s+/ },
    { name: 'markdown', regex: /^\s*#{1,6}\s+/ }
  ];
  
  for (const listType of listPatterns) {
    const matches = lines.filter(line => listType.regex.test(line));
    const occurrence = matches.length / lines.length;
    
    if (occurrence > 0.2) {
      return {
        pattern: {
          type: 'list',
          value: listType.name,
          confidence: occurrence
        }
      };
    }
  }
  
  return { pattern: null };
}

// Analizar pares clave-valor
private analyzeKeyValuePairs(lines: string[]): { pattern: StructurePattern | null } {
  const kvPatterns = [
    /^[^:]+:\s*.+$/,
    /^[^=]+=\s*.+$/,
    /^[^→]+→\s*.+$/
  ];
  
  let maxMatches = 0;
  let bestPattern = null;
  
  for (const pattern of kvPatterns) {
    const matches = lines.filter(line => pattern.test(line.trim()));
    if (matches.length > maxMatches) {
      maxMatches = matches.length;
      bestPattern = pattern;
    }
  }
  
  const occurrence = maxMatches / lines.length;
  
  if (occurrence > 0.3) {
    return {
      pattern: {
        type: 'key-value',
        value: bestPattern?.source || '',
        confidence: occurrence
      }
    };
  }
  
  return { pattern: null };
}

// Analizar estructura de tabla
private analyzeTableStructure(lines: string[]): { isTable: boolean; confidence: number } {
  if (lines.length < 2) return { isTable: false, confidence: 0 };
  
  // Analizar formato de cada línea
  const lineFormats = lines.map(line => TextAnalysisUtils.getLineFormat(line));
  
  // Buscar consistencia en el número de columnas
  const columnCounts = lineFormats.map(f => f.columnCount);
  const modeColumnCount = this.getMode(columnCounts);
  const consistentLines = columnCounts.filter(c => c === modeColumnCount).length;
  const consistency = consistentLines / lines.length;
  
  // Verificar si hay una línea que parece header
  const hasHeader = lineFormats.slice(0, 3).some(f => f.isHeader);
  
  // Verificar si la mayoría tiene separadores
  const hasSeparators = lineFormats.filter(f => f.hasSeparator).length / lines.length;
  
  const isTable = consistency > 0.7 && modeColumnCount > 1 && hasSeparators > 0.7;
  const confidence = (consistency + hasSeparators + (hasHeader ? 0.2 : 0)) / 2.2;
  
  return { isTable, confidence: Math.min(confidence, 1) };
}

// Obtener la moda (valor más frecuente) de un array
private getMode(arr: number[]): number {
  const frequency: Record<number, number> = {};
  let maxFreq = 0;
  let mode = arr[0];
  
  arr.forEach(val => {
    frequency[val] = (frequency[val] || 0) + 1;
    if (frequency[val] > maxFreq) {
      maxFreq = frequency[val];
      mode = val;
    }
  });
  
  return mode;
}

// Preservar estructura detectada
private preserveStructure(text: string, analysis: DocumentStructureAnalysis): string {
  let structuredText = text;
  
  // Añadir metadatos de estructura al inicio
  const metadata: string[] = [];
  
  if (analysis.structureType !== 'unstructured') {
    metadata.push(`[ESTRUCTURA: ${analysis.structureType.toUpperCase()}]`);
  }
  
  if (analysis.patterns.length > 0) {
    const patternDesc = analysis.patterns
      .map(p => `${p.type}${p.value ? `:${p.value}` : ''}`)
      .join(', ');
    metadata.push(`[PATRONES: ${patternDesc}]`);
  }
  
  if (metadata.length > 0) {
    structuredText = metadata.join('\n') + '\n\n' + structuredText;
  }
  
  return structuredText;
}

// Reemplazar el método splitIntoChunks existente con:
private splitIntoChunks(text: string, documentId: string, knowledgeBaseId: string): DocumentChunk[] {
  const lines = text.split('\n');
  
  // Detectar bloques semánticos automáticamente
  const semanticBlocks = this.detectSemanticBlocks(lines);
  
  this.logger.info(`Documento ${documentId}: ${semanticBlocks.length} bloques semánticos detectados`);
  
  const chunks: DocumentChunk[] = [];
  
  semanticBlocks.forEach((block, blockIndex) => {
    const blockChunks = this.createContextAwareChunks(
      block,
      documentId,
      knowledgeBaseId,
      blockIndex
    );
    chunks.push(...blockChunks);
  });
  
  return chunks;
}

// Detectar bloques semánticos en el documento
private detectSemanticBlocks(lines: string[]): SemanticBlock[] {
  const blocks: SemanticBlock[] = [];
  let currentBlock: SemanticBlock = {
    lines: [],
    type: 'unknown',
    metadata: {},
    startIndex: 0
  };
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nextLine = lines[i + 1];
    const prevLine = lines[i - 1];
    
    // Detectar si estamos en un límite de bloque
    const isBlockBoundary = this.isSemanticBoundary(line, nextLine, prevLine, currentBlock);
    
    if (isBlockBoundary && currentBlock.lines.length > 0) {
      // Finalizar bloque actual
      currentBlock.endIndex = i - 1;
      currentBlock.type = this.inferBlockType(currentBlock.lines);
      currentBlock.metadata = this.extractBlockMetadata(currentBlock);
      blocks.push(currentBlock);
      
      // Iniciar nuevo bloque
      currentBlock = {
        lines: [],
        type: 'unknown',
        metadata: {},
       startIndex: i
     };
   }
   
   currentBlock.lines.push(line);
 }
 
 // Añadir último bloque
 if (currentBlock.lines.length > 0) {
   currentBlock.endIndex = lines.length - 1;
   currentBlock.type = this.inferBlockType(currentBlock.lines);
   currentBlock.metadata = this.extractBlockMetadata(currentBlock);
   blocks.push(currentBlock);
 }
 
 return blocks;
}

// Detectar límites semánticos entre bloques
// En src/shared/handlers/knowledge/documentProcessorHandler.ts
private isSemanticBoundary(
    currentLine: string,
    nextLine: string | undefined,
    prevLine: string | undefined,
    currentBlock: SemanticBlock // currentBlock puede ser útil para ver el tipo del bloque actual
): boolean {
    const trimmedCurrentLine = currentLine.trim();
    const trimmedPrevLine = prevLine?.trim();
    const trimmedNextLine = nextLine?.trim();

    // 1. Múltiples líneas vacías son un claro separador
    if (!trimmedCurrentLine && trimmedPrevLine === "") {
        this.logger.debug(`[isSemanticBoundary] TRUE: Múltiples líneas vacías.`);
        return true;
    }

    // 2. NO dividir si la línea anterior y la actual parecen parte de la misma tabla.
    // Esta es una heurística clave para mantener las tablas unidas.
    if (trimmedPrevLine && trimmedCurrentLine) {
        const currentFormat = TextAnalysisUtils.getLineFormat(trimmedCurrentLine);
        const prevFormat = TextAnalysisUtils.getLineFormat(trimmedPrevLine);

        // Condición: si ambas líneas tienen separadores (ej. múltiples espacios, tabs implícitos por columnas)
        // Y el número de "columnas" inferidas es similar (y mayor que 1, para evitar falsos positivos en texto normal)
        // Y ninguna parece un encabezado de sección completamente diferente.
        if (currentFormat.hasSeparator && prevFormat.hasSeparator &&
            currentFormat.columnCount > 1 && prevFormat.columnCount > 1 &&
            Math.abs(currentFormat.columnCount - prevFormat.columnCount) <= 2) { // Permitir una variación de hasta 2 columnas
            
            // Si la línea previa parecía un header de tabla y la actual son datos, NO separar.
            if (TextAnalysisUtils.looksLikeHeader(trimmedPrevLine) && !TextAnalysisUtils.looksLikeHeader(trimmedCurrentLine)) {
                this.logger.debug(`[isSemanticBoundary] FALSE: Línea previa es header de tabla, actual es dato. Manteniendo bloque.`);
                return false;
            }
            // Si ambas son líneas de datos de tabla, NO separar.
            if (!TextAnalysisUtils.looksLikeHeader(trimmedPrevLine) && !TextAnalysisUtils.looksLikeHeader(trimmedCurrentLine)) {
                this.logger.debug(`[isSemanticBoundary] FALSE: Líneas previa y actual parecen datos de la misma tabla. Manteniendo bloque.`);
                return false;
            }
        }
    }

    // 3. Marcadores explícitos de sección (ej. ---, ===, ###) siempre crean un límite
    const sectionMarkers = /^[-=*_]{3,}$|^#{1,6}\s|^\[.*?\]$/; // El patrón de corchetes podría ser demasiado agresivo si tus datos los usan
    if (sectionMarkers.test(trimmedCurrentLine)) {
        // Evitar que un marcador dentro de un bloque ya identificado como tabla lo rompa, a menos que sea un header muy fuerte
        if (currentBlock.type === 'table' && !TextAnalysisUtils.looksLikeHeader(trimmedCurrentLine)) {
             this.logger.debug(`[isSemanticBoundary] FALSE: Marcador de sección ("${trimmedCurrentLine}") dentro de un bloque ya tipo tabla, y no es header.`);
             return false;
        }
        this.logger.debug(`[isSemanticBoundary] TRUE: Marcador de sección explícito: "${trimmedCurrentLine}"`);
        return true;
    }
    
    // 4. Un cambio muy drástico en la indentación o estructura podría ser un límite.
    // (Esta parte es más compleja de generalizar y puede requerir ajuste fino)
    // Podrías comparar la indentación (espacios al inicio) o la longitud de las líneas.
    // if (prevLine && Math.abs(currentLine.length - prevLine.length) > prevLine.length * 0.5 && Math.abs(currentLine.length - prevLine.length) > 20 ) {
    //     // Si hay un cambio muy grande en la longitud de la línea.
    // }


    // 5. Si la línea actual parece un título/encabezado y la anterior no lo era, y el bloque actual ya tiene contenido.
    if (TextAnalysisUtils.looksLikeHeader(trimmedCurrentLine) && 
        trimmedPrevLine && !TextAnalysisUtils.looksLikeHeader(trimmedPrevLine) && 
        currentBlock.lines.length > 0) {
        this.logger.debug(`[isSemanticBoundary] TRUE: Línea actual ("${trimmedCurrentLine}") parece nuevo header después de contenido.`);
        return true;
    }

    // Por defecto, no hay límite si no se cumple ninguna condición fuerte
    this.logger.debug(`[isSemanticBoundary] FALSE por defecto para: "<span class="math-inline">\{currentLine\}" \(prev\: "</span>{prevLine}")`);
    return false;
}

// Inferir el tipo de un bloque basado en su contenido
private inferBlockType(lines: string[]): SemanticBlock['type'] {
 const nonEmptyLines = lines.filter(l => l.trim());
 if (nonEmptyLines.length === 0) return 'unknown';
 
 // Analizar características del bloque
 const lineFormats = nonEmptyLines.map(l => TextAnalysisUtils.getLineFormat(l));
 
 // Verificar si es una tabla
 const columnCounts = lineFormats.map(f => f.columnCount);
 const avgColumns = columnCounts.reduce((a, b) => a + b, 0) / columnCounts.length;
 const hasConsistentColumns = columnCounts.filter(c => Math.abs(c - avgColumns) <= 1).length > columnCounts.length * 0.7;
 
 if (avgColumns > 1 && hasConsistentColumns) {
   return 'table';
 }
 
 // Verificar si es una lista
 const listPatterns = [
   /^\s*\d+[\.\)]\s+/,
   /^\s*[a-z][\.\)]\s+/i,
   /^\s*[-*•]\s+/
 ];
 
 const linesWithListPattern = nonEmptyLines.filter(line => 
   listPatterns.some(pattern => pattern.test(line))
 ).length;
 
 if (linesWithListPattern > nonEmptyLines.length * 0.5) {
   return 'list';
 }
 
 // Verificar si son headers
 if (nonEmptyLines.length <= 3 && nonEmptyLines.every(l => TextAnalysisUtils.looksLikeHeader(l))) {
   return 'header';
 }
 
 // Verificar si es estructurado (key-value, etc.)
 const structuredLines = nonEmptyLines.filter(l => TextAnalysisUtils.looksLikeKey(l)).length;
 if (structuredLines > nonEmptyLines.length * 0.5) {
   return 'structured';
 }
 
 // Por defecto es un párrafo
 return 'paragraph';
}

// Extraer metadata de un bloque
private extractBlockMetadata(block: SemanticBlock): Record<string, any> {
 const metadata: Record<string, any> = {};
 
 // Contar elementos numéricos
 const numbers = block.lines.flatMap(line => TextAnalysisUtils.extractNumbers(line));
 metadata.hasNumbers = numbers.length > 0;
 metadata.numberCount = numbers.length;
 
 if (numbers.length > 0) {
   metadata.numberRange = {
     min: Math.min(...numbers),
     max: Math.max(...numbers)
   };
 }
 
 // Detectar si tiene headers
 const headerLines = block.lines.filter(l => TextAnalysisUtils.looksLikeHeader(l));
 metadata.hasHeaders = headerLines.length > 0;
 if (headerLines.length > 0) {
   metadata.headers = headerLines.slice(0, 3);
 }
 
 // Detectar idioma dominante
 metadata.language = TextAnalysisUtils.detectLanguage(block.lines.join(' '));
 
 // Para tablas, detectar columnas
 if (block.type === 'table') {
   const formats = block.lines.map(l => TextAnalysisUtils.getLineFormat(l));
   const columnCounts = formats.map(f => f.columnCount);
   metadata.columnCount = this.getMode(columnCounts);
   metadata.hasConsistentStructure = formats.filter(f => f.columnCount === metadata.columnCount).length / formats.length;
 }
 
 return metadata;
}

// Crear chunks preservando contexto
private createContextAwareChunks(
 block: SemanticBlock,
 documentId: string,
 knowledgeBaseId: string,
 blockIndex: number
): DocumentChunk[] {
 const chunks: DocumentChunk[] = [];
 const blockText = block.lines.join('\n');
 
   // NO crear chunks si el bloque está completamente vacío
  if (!blockText.trim()) {
    this.logger.warn(`Bloque ${blockIndex} está vacío, omitiendo`);
    return chunks;
  }

 // Si el bloque es pequeño, no dividirlo
 if (blockText.length <= this.chunkSize) {
   chunks.push({
     id: `${documentId}_chunk_${blockIndex}_0`,
     documentId,
     knowledgeBaseId,
     content: blockText,
     position: blockIndex * 1000,
     tokenCount: this.estimateTokenCount(blockText),
     metadata: {
       blockType: block.type,
       blockIndex: blockIndex,
       ...block.metadata,
       isCompleteBlock: true
     }
   });
   return chunks;
 }
 
 // Para bloques grandes, usar estrategia según el tipo
 switch (block.type) {
   case 'table':
   case 'structured':
     return this.createTableAwareChunks(block, documentId, knowledgeBaseId, blockIndex);
   
   case 'list':
     return this.createListAwareChunks(block, documentId, knowledgeBaseId, blockIndex);
   
   default:
     return this.createOverlappingChunks(block, documentId, knowledgeBaseId, blockIndex);
 }
}

// Crear chunks para datos tabulares preservando headers
private createRegularTableChunks(
  block: SemanticBlock,
  documentId: string,
  knowledgeBaseId: string,
  blockIndex: number
): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  
  // Identificar headers (primeras líneas que parecen encabezados)
  const headerLines: string[] = [];
  let dataStartIndex = 0;
  
  for (let i = 0; i < Math.min(3, block.lines.length); i++) {
    if (TextAnalysisUtils.looksLikeHeader(block.lines[i]) || i === 0) {
      headerLines.push(block.lines[i]);
      dataStartIndex = i + 1;
    } else {
      break;
    }
  }
  
  // Si no hay headers claros, usar la primera línea
  if (headerLines.length === 0 && block.lines.length > 0) {
    headerLines.push(block.lines[0]);
    dataStartIndex = 1;
  }
  
  const headerText = headerLines.join('\n');
  
  // **NUEVA LÓGICA: Para listas de precios/datos críticos, hacer chunks más grandes**
  const isComparisonCritical = this.isComparisonCriticalData(block.lines, headerText);
  const dynamicChunkSize = isComparisonCritical ? this.chunkSize * 3 : this.chunkSize; // 3x más grande para comparaciones
  
  let currentChunk = headerText;
  let chunkIndex = 0;
  let linesInCurrentChunk = headerLines.length;
  
  // Añadir líneas de datos preservando headers en cada chunk
  for (let i = dataStartIndex; i < block.lines.length; i++) {
    const line = block.lines[i];
    const lineWithNewline = '\n' + line;
    
    if (currentChunk.length + lineWithNewline.length > dynamicChunkSize && linesInCurrentChunk > headerLines.length) {
      // **CRÍTICO: Para datos de comparación, asegurar mínimo de filas**
      if (isComparisonCritical && (linesInCurrentChunk - headerLines.length) < 10) {
        // Continuar añadiendo hasta tener al menos 10 filas de datos
        currentChunk += lineWithNewline;
        linesInCurrentChunk++;
        continue;
      }
      
      // Guardar chunk actual
      chunks.push({
        id: `${documentId}_chunk_${blockIndex}_${chunkIndex}`,
        documentId,
        knowledgeBaseId,
        content: currentChunk,
        position: blockIndex * 1000 + chunkIndex,
        tokenCount: this.estimateTokenCount(currentChunk),
        metadata: {
          blockType: block.type,
          blockIndex: blockIndex,
          chunkIndex: chunkIndex,
          hasHeaders: true,
          headerLines: headerLines.length,
          isComparisonCritical: isComparisonCritical, // **NUEVO FLAG**
          dataRowCount: linesInCurrentChunk - headerLines.length, // **NUEVO CONTADOR**
          ...block.metadata
        }
      });
      
      // Iniciar nuevo chunk con headers
      currentChunk = headerText;
      linesInCurrentChunk = headerLines.length;
      chunkIndex++;
    }
    
    currentChunk += lineWithNewline;
    linesInCurrentChunk++;
  }
  
  // Añadir último chunk
  if (linesInCurrentChunk > headerLines.length && currentChunk.trim().length > 0) {
    chunks.push({
      id: `${documentId}_chunk_${blockIndex}_${chunkIndex}`,
      documentId,
      knowledgeBaseId,
      content: currentChunk,
      position: blockIndex * 1000 + chunkIndex,
      tokenCount: this.estimateTokenCount(currentChunk),
      metadata: {
        blockType: block.type,
        blockIndex: blockIndex,
        chunkIndex: chunkIndex,
        hasHeaders: true,
        headerLines: headerLines.length,
        isComparisonCritical: isComparisonCritical,
        dataRowCount: linesInCurrentChunk - headerLines.length,
        ...block.metadata
      }
    });
  }
  
  return chunks;
}

// 2. NUEVO MÉTODO: Detectar datos críticos para comparación
private isComparisonCriticalData(lines: string[], headerText: string): boolean {
  const allText = (headerText + '\n' + lines.join('\n')).toLowerCase();
  
  // Detectores genéricos para datos de comparación crítica
  const comparisonKeywords = [
    // Precios y finanzas
    'precio', 'price', 'cost', 'costo', '$', 'usd', 'mxn', 'eur', 'total', 'lista',
    // Productos/unidades comparables
    'unidad', 'unit', 'producto', 'product', 'modelo', 'model', 'tipo', 'type',
    // Métricas comparables
    'ranking', 'score', 'rating', 'nivel', 'level', 'grado', 'grade',
    // Identificadores tabulares
    'id', 'código', 'code', 'ref', 'referencia', 'sku',
    // Dimensiones/medidas
    'm²', 'm2', 'metros', 'size', 'tamaño', 'superficie'
  ];
  
  const matchCount = comparisonKeywords.filter(keyword => allText.includes(keyword)).length;
  
  // También verificar si hay múltiples valores numéricos (señal de datos comparables)
  const numbers = TextAnalysisUtils.extractNumbers(allText);
  const hasMultipleNumbers = numbers.length >= 5;
  
  // Verificar estructura tabular consistente
  const nonEmptyLines = lines.filter(l => l.trim());
  const avgColumnsPerLine = nonEmptyLines.reduce((sum, line) => {
    const format = TextAnalysisUtils.getLineFormat(line);
    return sum + format.columnCount;
  }, 0) / nonEmptyLines.length;
  
  const hasTabularStructure = avgColumnsPerLine >= 2;
  
  // Es crítico si cumple al menos 2 de 3 condiciones
  const criticalScore = (matchCount >= 2 ? 1 : 0) + 
                       (hasMultipleNumbers ? 1 : 0) + 
                       (hasTabularStructure ? 1 : 0);
  
  return criticalScore >= 2;
}

// Crear chunks para listas preservando contexto
private createListAwareChunks(
 block: SemanticBlock,
 documentId: string,
 knowledgeBaseId: string,
 blockIndex: number
): DocumentChunk[] {
 const chunks: DocumentChunk[] = [];
 
 // Identificar el título o contexto de la lista
 let contextLines: string[] = [];
 let listStartIndex = 0;
 
 // Buscar líneas que no son parte de la lista para usar como contexto
 for (let i = 0; i < block.lines.length; i++) {
   if (!this.isListItem(block.lines[i])) {
     contextLines.push(block.lines[i]);
   } else {
     listStartIndex = i;
     break;
   }
 }
 
 const contextText = contextLines.join('\n');
 let currentChunk = contextText;
 let chunkIndex = 0;
 let itemsInCurrentChunk = 0;
 
 // Procesar items de la lista
 for (let i = listStartIndex; i < block.lines.length; i++) {
   const line = block.lines[i];
   const lineWithNewline = (currentChunk ? '\n' : '') + line;
   
   if (currentChunk.length + lineWithNewline.length > this.chunkSize && itemsInCurrentChunk > 0) {
     // Guardar chunk actual
     chunks.push({
       id: `${documentId}_chunk_${blockIndex}_${chunkIndex}`,
       documentId,
       knowledgeBaseId,
       content: currentChunk,
       position: blockIndex * 1000 + chunkIndex,
       tokenCount: this.estimateTokenCount(currentChunk),
       metadata: {
         blockType: block.type,
         blockIndex: blockIndex,
         chunkIndex: chunkIndex,
         hasContext: contextLines.length > 0,
         itemCount: itemsInCurrentChunk,
         ...block.metadata
       }
     });
     
     // Iniciar nuevo chunk con contexto
     currentChunk = contextText;
     itemsInCurrentChunk = 0;
     chunkIndex++;
   }
   
   currentChunk += lineWithNewline;
   if (this.isListItem(line)) {
     itemsInCurrentChunk++;
   }
 }
 
 // Añadir último chunk
 if (itemsInCurrentChunk > 0 || currentChunk !== contextText) {
   chunks.push({
     id: `${documentId}_chunk_${blockIndex}_${chunkIndex}`,
     documentId,
     knowledgeBaseId,
     content: currentChunk,
     position: blockIndex * 1000 + chunkIndex,
     tokenCount: this.estimateTokenCount(currentChunk),
     metadata: {
       blockType: block.type,
       blockIndex: blockIndex,
       chunkIndex: chunkIndex,
       hasContext: contextLines.length > 0,
       itemCount: itemsInCurrentChunk,
       ...block.metadata
     }
   });
 }
 
 return chunks;
}

// Verificar si una línea es un item de lista
private isListItem(line: string): boolean {
 const listPatterns = [
   /^\s*\d+[\.\)]\s+/,
   /^\s*[a-z][\.\)]\s+/i,
   /^\s*[-*•]\s+/,
   /^\s*\[[ x]\]\s+/i // Checkboxes
 ];
 
 return listPatterns.some(pattern => pattern.test(line));
}

// Crear chunks con overlap para texto general
private createOverlappingChunks(
 block: SemanticBlock,
 documentId: string,
 knowledgeBaseId: string,
 blockIndex: number
): DocumentChunk[] {
 const chunks: DocumentChunk[] = [];
 const text = block.lines.join('\n');
 
 let start = 0;
 let chunkIndex = 0;
 
 while (start < text.length) {
   // Determinar el final del chunk
   let end = start + this.chunkSize;
   
   // Ajustar para no cortar palabras
   if (end < text.length) {
     const lastSpace = text.lastIndexOf(' ', end);
     if (lastSpace > start + this.chunkSize * 0.8) {
       end = lastSpace;
     }
   } else {
     end = text.length;
   }
   
   const chunkContent = text.substring(start, end);
   
   chunks.push({
     id: `${documentId}_chunk_${blockIndex}_${chunkIndex}`,
     documentId,
     knowledgeBaseId,
     content: chunkContent,
     position: blockIndex * 1000 + chunkIndex,
     tokenCount: this.estimateTokenCount(chunkContent),
     metadata: {
       blockType: block.type,
       blockIndex: blockIndex,
       chunkIndex: chunkIndex,
       hasOverlap: chunkIndex > 0,
       ...block.metadata
     }
   });
   
   // Mover el inicio considerando overlap
   start = end - this.chunkOverlap;
   if (start < 0) start = 0;
   
   chunkIndex++;
 }
 
 return chunks;
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
      
      let text = '';
      
      // Extraer texto de cada página
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        
        // Concatenar el texto de todos los elementos de la página
        const pageText = content.items
          .map((item: any) => item.str)
          .join(' ');
        
        text += pageText + '\n\n';
      }
      
      return text;
    } catch (error: unknown) {
      this.logger.error('Error al extraer texto de PDF:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
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
      this.logger.error('Error al extraer texto de Word:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`No se pudo extraer texto del documento Word: ${errorMessage}`);
    }
  }
  
  /**
   * Extrae texto de un archivo CSV
   */
  private async extractTextFromCsv(buffer: Buffer): Promise<string> {
    try {
      // Usar xlsx para leer el CSV
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      
      // Convertir a JSON
      const data = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });
      
      // Convertir a texto
      return data.map((row: any) => row.join(', ')).join('\n');
    } catch (error: unknown) {
      this.logger.error('Error al extraer texto de CSV:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`No se pudo extraer texto del CSV: ${errorMessage}`);
    }
  }
  
  /**
   * Extrae texto de un archivo JSON
   */
  private async extractTextFromJson(buffer: Buffer): Promise<string> {
    try {
      const jsonString = buffer.toString('utf-8');
      const jsonData = JSON.parse(jsonString);
      
      // Si hay un campo específico de contenido, usarlo
      if (jsonData.content) {
        return jsonData.content;
      }
      
      // Si no, convertir todo el objeto a texto
      return JSON.stringify(jsonData, null, 2);
    } catch (error: unknown) {
      this.logger.error('Error al extraer texto de JSON:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`No se pudo extraer texto del JSON: ${errorMessage}`);
    }
  }
  
  /**
   * Normaliza el texto para eliminar caracteres innecesarios
   */
  private normalizeText(text: string): string {
    return text
      .replace(/\r\n/g, '\n') // Normalizar saltos de línea
      .replace(/\t/g, ' ') // Reemplazar tabulaciones con espacios
      .replace(/\n{3,}/g, '\n\n') // Reemplazar múltiples saltos de línea con máximo dos
      .replace(/ {2,}/g, ' ') // Reemplazar múltiples espacios con uno solo
      .trim(); // Eliminar espacios al inicio y final
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
      const containerClient = this.storageService.getBlobContainerClient(BLOB_CONTAINERS.PROCESSED_DOCUMENTS);
      
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
      const metadataBlockBlobClient = containerClient.getBlockBlobClient(metadataBlobName);
      
      const metadata = {
        documentId,
        knowledgeBaseId,
        agentId,
        chunkCount: chunks.length,
        chunkSize: this.chunkSize,
        chunkOverlap: this.chunkOverlap,
        chunks: chunks.map(chunk => ({
          id: chunk.id,
          position: chunk.position,
          tokenCount: chunk.tokenCount
        }))
      };
      
      const metadataContent = JSON.stringify(metadata, null, 2);
      await metadataBlockBlobClient.upload(metadataContent, metadataContent.length);
      
      this.logger.debug(`Chunks guardados en Blob Storage para documento ${documentId}`);
    } catch (error: unknown) {
      this.logger.error(`Error al guardar chunks en Blob Storage:`, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
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
      const queueClient = this.storageService.getQueueClient(STORAGE_QUEUES.EMBEDDING);
      
      // Encolar cada chunk para procesar
      for (const chunk of chunks) {
        const message: EmbeddingQueueMessage = {
          chunkId: chunk.id,
          documentId,
          knowledgeBaseId,
          agentId,
          content: chunk.content,
          position: chunk.position,
  metadata: chunk.metadata
        };
        
        await queueClient.sendMessage(Buffer.from(JSON.stringify(message)).toString('base64'));
      }
      
      this.logger.debug(`${chunks.length} chunks encolados para generación de embeddings`);
    } catch (error: unknown) {
      this.logger.error(`Error al encolar chunks para embeddings:`, error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw createAppError(500, `Error al encolar chunks: ${errorMessage}`);
    }
  }
  
  /**
   * Obtiene la extensión de un archivo
   */
  private getFileExtension(filename: string): string {
    const parts = filename.split('.');
    return parts.length > 1 ? `.${parts[parts.length - 1]}` : '';
  }








private isPriceTable(lines: string[], headerText: string): boolean { // Asegúrate que devuelva boolean
  // El 'headerText' aquí es la primera línea del bloque actual, no necesariamente el header original del PDF.
  const allTextForBlock = (headerText + '\n' + lines.join('\n')).toLowerCase();

  const priceIndicators = [
    '$', 'precio', 'price', 'costo', 'cost', 'lista', // 'lista 1' podría estar en el header original
    'mxn', 'usd', 'eur', 'total', 'subtotal'
    // Quité 'lista' de aquí para probar, ya que "Lista 1" es parte del header. El '$' debería ser un buen indicador.
  ];
  const unitIndicators = [
    'unidad', 'unit', 'id', // "ID Unidad" es parte del header original
    'código', 'code', 'item', 'producto'
  ];

  // Log para ver el texto que se está analizando para este bloque específico
  this.logger.debug(`[isPriceTable] Analizando texto de bloque (primeros 300 chars): ${allTextForBlock.substring(0, 300)}`);
  this.logger.debug(`[isPriceTable] HeaderText para este bloque: ${headerText}`);


  let hasPrice = false;
  for (const indicator of priceIndicators) {
    if (allTextForBlock.includes(indicator.toLowerCase())) {
      hasPrice = true;
      this.logger.debug(`[isPriceTable] Indicador de precio encontrado: "${indicator}"`);
      break;
    }
  }

  let hasUnits = false;
  for (const indicator of unitIndicators) {
    if (allTextForBlock.includes(indicator.toLowerCase())) {
      hasUnits = true;
      this.logger.debug(`[isPriceTable] Indicador de unidad encontrado: "${indicator}"`);
      break;
    }
  }
  
  // Regex mejorado para precios, buscando explícitamente el símbolo $ y luego números.
  const moneyPattern = /\$\s*[\d,]+(?:\.\d{2})?/g; 
  const moneyMatches = allTextForBlock.match(moneyPattern);
  const numberOfPriceMatches = moneyMatches ? moneyMatches.length : 0;
  // Para una tabla de precios, esperamos múltiples coincidencias de precios.
  // El umbral puede depender del tamaño típico de tus bloques semánticos.
  // Si un bloque semántico es pequeño (pocas líneas), este umbral podría ser más bajo.
  // Para un bloque de 32 líneas como el del log, >= 5 podría ser razonable.
  const hasMultiplePrices = numberOfPriceMatches >= 3; // Ajusta este umbral según sea necesario. 3 es un mínimo.

  this.logger.debug(`[isPriceTable] Condición 'hasPrice': ${hasPrice}`);
  this.logger.debug(`[isPriceTable] Condición 'hasUnits': ${hasUnits}`);
  this.logger.debug(`[isPriceTable] Número de coincidencias de precios (moneyMatches): ${numberOfPriceMatches}`);
  this.logger.debug(`[isPriceTable] Condición 'hasMultiplePrices' (necesita >=3): ${hasMultiplePrices}`);
  
  const result = hasPrice && hasUnits && hasMultiplePrices;
  this.logger.info(`[isPriceTable] Resultado final para el bloque: ${result}`);
  return result;
}

// 2. CREAR CHUNKS ESPECÍFICOS PARA TABLAS DE PRECIOS
private createPriceTableChunks(
  block: SemanticBlock,
  documentId: string,
  knowledgeBaseId: string,
  blockIndex: number
): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  
  // Identificar header
  const headerLines: string[] = [];
  let dataStartIndex = 0;
  
  for (let i = 0; i < Math.min(3, block.lines.length); i++) {
    if (TextAnalysisUtils.looksLikeHeader(block.lines[i]) || i === 0) {
      headerLines.push(block.lines[i]);
      dataStartIndex = i + 1;
    } else {
      break;
    }
  }
  
  const headerText = headerLines.join('\n');
  const dataLines = block.lines.slice(dataStartIndex);
  
  // **ESTRATEGIA ESPECÍFICA PARA PRECIOS: Crear chunks que permitan comparaciones**
  
  // Chunk 1: TODOS los precios ordenados de menor a mayor
  const sortedPricesChunk = this.createSortedPricesChunk(
    headerText, dataLines, documentId, knowledgeBaseId, blockIndex, 0
  );
  if (sortedPricesChunk) chunks.push(sortedPricesChunk);
  
  // Chunk 2: Rangos de precios agrupados
  const priceRangeChunks = this.createPriceRangeChunks(
    headerText, dataLines, documentId, knowledgeBaseId, blockIndex, 1
  );
  chunks.push(...priceRangeChunks);
  
  // Chunk 3: Chunk con tabla completa dividida en secciones manejables
  const fullTableChunks = this.createFullTableChunks(
    headerText, dataLines, documentId, knowledgeBaseId, blockIndex, 10
  );
  chunks.push(...fullTableChunks);
  
  return chunks;
}

// 3. CHUNK CON PRECIOS ORDENADOS (para encontrar mínimos/máximos fácilmente)
private createSortedPricesChunk(
  headerText: string,
  dataLines: string[],
  documentId: string,
  knowledgeBaseId: string,
  blockIndex: number,
  chunkIndex: number
): DocumentChunk | null {
  
  // Extraer y ordenar precios
  const priceRows: Array<{line: string, price: number}> = [];
  
  dataLines.forEach(line => {
    const priceMatch = line.match(/\$\s*([\d,]+)/);
    if (priceMatch) {
      const priceStr = priceMatch[1].replace(/,/g, '');
      const price = parseInt(priceStr);
      if (!isNaN(price)) {
        priceRows.push({ line, price });
      }
    }
  });
  
  if (priceRows.length === 0) return null;
  
  // Ordenar por precio
  priceRows.sort((a, b) => a.price - b.price);
  
  // Crear contenido del chunk
  let content = headerText + '\n\n';
  content += '[PRECIOS ORDENADOS DE MENOR A MAYOR]\n';
  content += priceRows.map(row => row.line).join('\n');
  content += '\n\n[RESUMEN]\n';
  content += `Precio más barato: $${priceRows[0].price.toLocaleString()}\n`;
  content += `Precio más caro: $${priceRows[priceRows.length - 1].price.toLocaleString()}\n`;
  content += `Total de opciones: ${priceRows.length}`;
  
  return {
    id: `${documentId}_chunk_${blockIndex}_${chunkIndex}_sorted_prices`,
    documentId,
    knowledgeBaseId,
    content,
    position: blockIndex * 1000 + chunkIndex,
    tokenCount: this.estimateTokenCount(content),
    metadata: {
      blockType: 'price_table_sorted',
      blockIndex: blockIndex,
      chunkIndex: chunkIndex,
      isComparisonCritical: true,
      isPriceTable: true,
      priceCount: priceRows.length,
      minPrice: priceRows[0].price,
      maxPrice: priceRows[priceRows.length - 1].price,
      hasHeaders: true
    }
  };
}

private sanitizeForId(text: string): string {
    if (!text) return '';
    return text
        .normalize("NFD") // Descompone acentos: "ó" -> "o" + "´"
        .replace(/[\u0300-\u036f]/g, "") // Elimina diacríticos (acentos)
        .replace(/[^a-zA-Z0-9_-]/g, '_'); // Reemplaza cualquier no alfanumérico (excepto _ y -) con _
}

private createPriceRangeChunks(
    headerText: string,
    dataLines: string[],
    documentId: string,
    knowledgeBaseId: string,
    blockIndex: number,
    baseChunkIndexInBlock: number // Índice inicial para este set de chunks de rango
): DocumentChunk[] {
    const chunks: DocumentChunk[] = [];
    if (!dataLines || dataLines.length === 0) {
        this.logger.warn(`[createPriceRangeChunks] No hay dataLines para procesar para el documento ${documentId}, bloque ${blockIndex}.`);
        return chunks;
    }

    const priceRows: Array<{ line: string, price: number }> = [];
    dataLines.forEach(line => {
        // Intenta extraer precios. Ajusta el regex si tu formato de precio es diferente.
        // Este regex busca "$", seguido de números y comas, opcionalmente con dos decimales.
        const priceMatch = line.match(/\$\s*([\d,]+(?:\.\d{2})?)/); 
        if (priceMatch && priceMatch[1]) {
            const priceStr = priceMatch[1].replace(/,/g, ''); // Eliminar comas para parsear
            const price = parseFloat(priceStr);
            if (!isNaN(price)) {
                priceRows.push({ line, price });
            }
        }
    });

    if (priceRows.length === 0) {
        this.logger.warn(`[createPriceRangeChunks] No se encontraron precios en dataLines para el documento ${documentId}, bloque ${blockIndex}.`);
        return chunks;
    }

    priceRows.sort((a, b) => a.price - b.price);

    const numRanges = 3;
    const totalPrices = priceRows.length;
    const baseRangeSize = Math.floor(totalPrices / numRanges);
    let remainder = totalPrices % numRanges;

    const rangeDefinitions: { name: string, rows: Array<{ line: string, price: number }> }[] = [];
    let currentIndex = 0;

    // Definir los rangos
    const rangeNames = ['ECONÓMICOS', 'INTERMEDIOS', 'PREMIUM'];
    for (let i = 0; i < numRanges; i++) {
        const currentRangeSize = baseRangeSize + (remainder > 0 ? 1 : 0);
        if (remainder > 0) {
            remainder--;
        }
        const endOfRangeIndex = currentIndex + currentRangeSize;
        rangeDefinitions.push({
            name: rangeNames[i],
            rows: priceRows.slice(currentIndex, endOfRangeIndex)
        });
        currentIndex = endOfRangeIndex;
    }
    
    rangeDefinitions.forEach((rangeDef, rangeIdx) => {
        if (rangeDef.rows.length > 0) {
            let chunkContent = headerText ? headerText + '\n\n' : ''; // Incluir header si existe
            chunkContent += `[RANGO ${rangeDef.name}]\n`; // Marcador de rango
            chunkContent += rangeDef.rows.map(row => row.line).join('\n');
            
            const firstPrice = rangeDef.rows[0].price;
            const lastPrice = rangeDef.rows[rangeDef.rows.length - 1].price;
            chunkContent += `\n\n(Este rango de ${rangeDef.name.toLowerCase()} cubre precios desde $${firstPrice.toLocaleString()} hasta $${lastPrice.toLocaleString()})`;

            const safeRangeName = this.sanitizeForId(rangeDef.name.toLowerCase());
            const calculatedChunkIndex = baseChunkIndexInBlock + rangeIdx;
            
            const newChunkId = `${documentId}_chunk_${blockIndex}_${calculatedChunkIndex}_range_${safeRangeName}`;

            this.logger.debug(`[createPriceRangeChunks] Preparando chunk de rango. ID Generado: "${newChunkId}", Nombre Original del Rango: "${rangeDef.name}", Nombre Sanitizado: "${safeRangeName}"`);

            chunks.push({
                id: newChunkId,
                documentId,
                knowledgeBaseId,
                content: chunkContent,
                position: blockIndex * 10000 + calculatedChunkIndex * 100, // Lógica de posición ejemplo
                tokenCount: this.estimateTokenCount(chunkContent),
                metadata: {
                    blockType: 'price_table_range',
                    blockIndex: blockIndex,
                    chunkIndexInBlock: calculatedChunkIndex,
                    isComparisonCritical: true,
                    isPriceTable: true,
                    priceRangeName: rangeDef.name, // Nombre original para referencia
                    priceRangeIdSuffix: safeRangeName, // Sufijo usado en el ID
                    priceCount: rangeDef.rows.length,
                    minPriceInRange: firstPrice,
                    maxPriceInRange: lastPrice,
                    hasHeaders: !!headerText 
                }
            });
        }
    });

    this.logger.info(`[createPriceRangeChunks] Generados ${chunks.length} chunks de rango para doc ${documentId}, bloque ${blockIndex}.`);
    return chunks;
}

// 5. CHUNKS DE TABLA COMPLETA (secciones manejables)
private createFullTableChunks(
  headerText: string,
  dataLines: string[],
  documentId: string,
  knowledgeBaseId: string,
  blockIndex: number,
  startChunkIndex: number
): DocumentChunk[] {
  const chunks: DocumentChunk[] = [];
  
  // Dividir en secciones de ~15 filas cada una (para mantener contexto)
  const sectionSize = 15;
  const sections = [];
  
  for (let i = 0; i < dataLines.length; i += sectionSize) {
    sections.push(dataLines.slice(i, i + sectionSize));
  }
  
  sections.forEach((section, index) => {
    let content = headerText + '\n';
    content += section.join('\n');
    
    // Añadir información de contexto
    content += `\n\n[SECCIÓN ${index + 1} de ${sections.length}]`;
    
    chunks.push({
      id: `${documentId}_chunk_${blockIndex}_${startChunkIndex + index}_section`,
      documentId,
      knowledgeBaseId,
      content,
      position: blockIndex * 1000 + startChunkIndex + index,
      tokenCount: this.estimateTokenCount(content),
      metadata: {
        blockType: 'price_table_section',
        blockIndex: blockIndex,
        chunkIndex: startChunkIndex + index,
        isComparisonCritical: true,
        isPriceTable: true,
        sectionNumber: index + 1,
        totalSections: sections.length,
        hasHeaders: true
      }
    });
  });
  
  return chunks;
}

// 6. MODIFICAR createTableAwareChunks para usar la lógica de precios
private createTableAwareChunks(
  block: SemanticBlock,
  documentId: string,
  knowledgeBaseId: string,
  blockIndex: number
): DocumentChunk[] {
  
  this.logger.debug(`[createTableAwareChunks] Analizando bloque con ${block.lines.length} líneas. Primeras líneas: ${block.lines.slice(0,3).join('\\n')}`);
const isTableOfPrices = this.isPriceTable(block.lines, block.lines[0] || '');
this.logger.info(`[createTableAwareChunks] Resultado de isPriceTable para el bloque: ${isTableOfPrices}`);



  // **NUEVO: Detectar si es tabla de precios específicamente**
  if (this.isPriceTable(block.lines, block.lines[0] || '')) {
    this.logger.info(`Detectada tabla de precios en bloque ${blockIndex}. Usando chunking especializado.`);
    return this.createPriceTableChunks(block, documentId, knowledgeBaseId, blockIndex);
  }

  if (isTableOfPrices) { // Asegúrate que isPriceTable devuelva un booleano claro
    this.logger.info(`[createTableAwareChunks] Detectada tabla de precios en bloque. Llamando a createPriceTableChunks.`);
    return this.createPriceTableChunks(block, documentId, knowledgeBaseId, blockIndex);
} else {
    this.logger.info(`[createTableAwareChunks] NO detectada tabla de precios. Llamando a createRegularTableChunks.`);
    return this.createRegularTableChunks(block, documentId, knowledgeBaseId, blockIndex);
}
  
}

}