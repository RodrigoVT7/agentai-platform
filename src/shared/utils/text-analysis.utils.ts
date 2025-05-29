// src/shared/utils/text-analysis.utils.ts

import { LineFormat } from "../models/document-analysis.model";

export class TextAnalysisUtils {
  
  /**
   * Detecta si una línea parece ser un encabezado
   */
  static looksLikeHeader(line: string | undefined): boolean {
    if (!line) return false;
    
    const trimmed = line.trim();
    if (trimmed.length === 0) return false;
    
    // Patrones comunes de headers
    const headerPatterns = [
      /^#{1,6}\s+/,                    // Markdown
      /^[A-Z][A-Z\s]{2,}$/,            // TODO MAYÚSCULAS
      /^[A-Z][a-zA-Z\s]+:$/,           // Título con dos puntos
      /^\d+\.\s+[A-Z]/,                // 1. Título
      /^[A-Z][a-zA-Z\s]+\s*-+$/,       // Título con línea
      /^[A-Z][a-zA-Z\s]+\s*=+$/,       // Título con línea doble
      /^\[[^\]]+\]$/,                  // [Título entre corchetes]
      /^<[^>]+>$/,                     // <Título entre brackets>
    ];
    
    return headerPatterns.some(pattern => pattern.test(trimmed)) ||
           (trimmed.length < 100 && /^[A-Z]/.test(trimmed) && !/[.!?]$/.test(trimmed));
  }
  
  /**
   * Detecta si una línea parece ser una clave en un par clave-valor
   */
  static looksLikeKey(line: string): boolean {
    const keyPatterns = [
      /^[\w\s]+:\s*.+$/,               // Clave: valor
      /^[\w\s]+=\s*.+$/,               // Clave = valor
      /^[\w\s]+\s*->\s*.+$/,           // Clave -> valor
      /^[\w\s]+\s*=>\s*.+$/,           // Clave => valor
      /^[\w\s]+\t+.+$/,                // Clave    valor (con tabs)
    ];
    
    return keyPatterns.some(pattern => pattern.test(line.trim()));
  }
  
  /**
   * Extrae números de un texto
   */
  static extractNumbers(text: string): number[] {
    const numbers: number[] = [];
    
    // Patrones para diferentes formatos numéricos
    const patterns = [
      /\$?\s*(\d{1,3}(?:,\d{3})*(?:\.\d+)?)/g,     // 1,234.56 o $1,234.56
      /\$?\s*(\d+(?:\.\d+)?)\s*[kKmMbB]?\b/g,      // 1.5k, 2.3M
      /(\d+(?:[.,]\d+)?)\s*%/g,                    // 85.5%
      /(?<!\w)(\d+(?:\.\d+)?)(?!\w)/g,             // Números simples
    ];
    
    patterns.forEach(pattern => {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        let numStr = match[1].replace(/,/g, '');
        
        // Convertir k, M, B
        if (/k$/i.test(match[0])) numStr = String(parseFloat(numStr) * 1000);
        if (/m$/i.test(match[0])) numStr = String(parseFloat(numStr) * 1000000);
        if (/b$/i.test(match[0])) numStr = String(parseFloat(numStr) * 1000000000);
        
        const num = parseFloat(numStr);
        if (!isNaN(num)) {
          numbers.push(num);
        }
      }
    });
    
    return [...new Set(numbers)]; // Eliminar duplicados
  }
  
  /**
   * Detecta el formato de una línea
   */
  static getLineFormat(line: string): LineFormat {
    const format: LineFormat = {
      hasSeparator: false,
      columnCount: 1,
      isHeader: false,
      isNumeric: false
    };
    
    // Detectar separadores
    const separators = [
      { type: 'tab', regex: /\t/, split: (l: string) => l.split(/\t/) },
      { type: 'pipe', regex: /\|/, split: (l: string) => l.split(/\|/).filter(s => s.trim()) },
      { type: 'comma', regex: /,/, split: (l: string) => l.split(/,/) },
      { type: 'multispace', regex: /\s{2,}/, split: (l: string) => l.split(/\s{2,}/) }
    ];
    
    for (const sep of separators) {
      if (sep.regex.test(line)) {
        const parts = sep.split(line);
        if (parts.length > 1) {
          format.hasSeparator = true;
          format.separatorType = sep.type;
          format.columnCount = parts.length;
          break;
        }
      }
    }
    
    // Detectar si es header
    format.isHeader = this.looksLikeHeader(line);
    
    // Detectar si es principalmente numérico
    const numbers = this.extractNumbers(line);
    format.isNumeric = numbers.length > 0 && numbers.length >= format.columnCount / 2;
    
    return format;
  }
  
  /**
   * Calcula la similitud entre dos formatos de línea
   */
  static formatSimilarity(format1: LineFormat, format2: LineFormat): number {
    let score = 0;
    
    if (format1.hasSeparator === format2.hasSeparator) score += 0.3;
    if (format1.separatorType === format2.separatorType) score += 0.3;
    if (Math.abs(format1.columnCount - format2.columnCount) <= 1) score += 0.4;
    
    return score;
  }
  
  /**
   * Extrae entidades (nombres propios, términos clave) de un texto
   */
  static extractEntities(text: string): string[] {
    const entities: string[] = [];
    
    // Palabras que empiezan con mayúscula (posibles nombres propios)
    const properNouns = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g) || [];
    entities.push(...properNouns);
    
    // Términos entre comillas
    const quoted = text.match(/["']([^"']+)["']/g) || [];
    entities.push(...quoted.map(q => q.replace(/["']/g, '')));
    
    // Códigos o identificadores (combinaciones de letras y números)
    const codes = text.match(/\b[A-Z]{2,}\d+\b|\b\d+[A-Z]+\b/g) || [];
    entities.push(...codes);
    
    return [...new Set(entities)].filter(e => e.length > 2);
  }
  
  /**
   * Detecta el idioma dominante en un texto
   */
  static detectLanguage(text: string): string {
    // Implementación simple basada en palabras comunes
  const languagePatterns = {
    es: /\b(el|la|de|que|y|a|en|un|ser|se|no|haber|por|con|para|como|estar|tener|su|al|lo|más|pero|sus|le|ya|o|este|él|sí|sin|sobre|hasta|también|cual|cuales|)\b/gi,
    en: /\b(the|be|to|of|and|a|in|that|have|I|it|for|not|on|with|he|as|you|do|at|this|but|his|by|from|they|we|say|her|she|or|an|will|my|one|all|would|there|their)\b/gi,
    pt: /\b(o|a|de|que|e|do|da|em|um|para|é|com|não|uma|os|no|se|na|por|mais|as|dos|como|mas|foi|ao|ele|das|tem|seu|sua|ou|há|quando|muito|nos|já|está|eu|também|só|pelo|pela|até|isso)\b/gi
  };
    
    let maxMatches = 0;
    let detectedLang = 'es'; // Default
    
    Object.entries(languagePatterns).forEach(([lang, pattern]) => {
      const matches = text.match(pattern) || [];
      if (matches.length > maxMatches) {
        maxMatches = matches.length;
        detectedLang = lang;
      }
    });
    
    return detectedLang;
  }
}