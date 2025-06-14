// src/shared/models/document-analysis.model.ts

export interface DocumentStructureAnalysis {
  hasStructure: boolean;
  structureType: 'unstructured' | 'tabular' | 'list' | 'mixed' | 'key-value';
  patterns: StructurePattern[];
  confidence: number;
}

export interface StructurePattern {
  type: 'separator' | 'list' | 'key-value' | 'header';
  value?: string | RegExp;
  confidence: number;
  metadata?: Record<string, any>;
}

export interface SemanticBlock {
  lines: string[];
  type: 'unknown' | 'structured' | 'paragraph' | 'list' | 'table' | 'header';
  metadata: Record<string, any>;
  startIndex?: number;
  endIndex?: number;
}

export interface ChunkStructure {
  isStructured: boolean;
  type: 'text' | 'tabular' | 'list' | 'key-value' | 'structured-list';
  hasNumericValues: boolean;
  hasComparisons: boolean;
  columnCount: number;
  patternConsistency: number;
  isComparisonCritical?: boolean; // **NUEVO CAMPO**
}

export interface LineFormat {
  hasSeparator: boolean;
  separatorType?: string;
  columnCount: number;
  isHeader: boolean;
  isNumeric: boolean;
}