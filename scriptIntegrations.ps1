# Nombre de la carpeta de destino
$destFolder = "sistema_documentos_chunks"

# Lista de archivos a copiar para el procesamiento de documentos
$filesToCopy = @(
    "src/shared/handlers/knowledge/documentProcessorHandler.ts",
    "src/shared/handlers/knowledge/embeddingGeneratorHandler.ts",
    "src/shared/models/document.model.ts",
    "src/shared/models/documentProcessor.model.ts",
    "src/shared/models/embedding.model.ts",
    "src/shared/models/document-analysis.model.ts",
    "src/shared/utils/text-analysis.utils.ts",
    "src/shared/constants/index.ts"
)

# Ruta completa de la carpeta de destino
$projectRoot = $PSScriptRoot
$fullDestPath = Join-Path -Path $projectRoot -ChildPath $destFolder

# Crear la carpeta de destino si no existe
if (-not (Test-Path -Path $fullDestPath -PathType Container)) {
    New-Item -ItemType Directory -Path $fullDestPath | Out-Null
    Write-Host "Carpeta '$destFolder' creada en '$projectRoot'."
} else {
    Write-Host "Carpeta '$destFolder' ya existe en '$projectRoot'."
}

# Copiar cada archivo
Write-Host "Iniciando copia de archivos a '$destFolder' (estructura plana)..."
foreach ($filePath in $filesToCopy) {
    $fullSourcePath = Join-Path -Path $projectRoot -ChildPath $filePath
    
    if (Test-Path -Path $fullSourcePath -PathType Leaf) {
        # Copiar directamente a la carpeta de destino, sin mantener estructura de subcarpetas
        Copy-Item -Path $fullSourcePath -Destination $fullDestPath
        $fileNameOnly = Split-Path -Path $fullSourcePath -Leaf
        Write-Host "Copiado: $fileNameOnly -> $fullDestPath"
    } else {
        Write-Warning "Archivo no encontrado - $filePath (ruta completa buscada: $fullSourcePath)"
    }
}

Write-Host "-----------------------------------------------------"
Write-Host "Proceso completado."
Write-Host "Los archivos seleccionados deberían estar en la carpeta: $fullDestPath"
Write-Host "Por favor, verifica la carpeta y los mensajes de advertencia si los hubiera."