# Nombre de la carpeta de destino
$destFolder = "motor extraccion de datos"

# Lista de archivos a copiar (rutas relativas a la ubicación del script)
$filesToCopy = @(
  "src/functions/knowledge/DocumentUpload.ts",
  "src/shared/handlers/knowledge/documentUploadHandler.ts",
  "src/shared/validators/knowledge/documentUploadValidator.ts",
  "src/functions/knowledge/DocumentProcessor.ts",
  "src/shared/handlers/knowledge/documentProcessorHandler.ts",
  "src/functions/knowledge/EmbeddingGenerator.ts",
  "src/shared/handlers/knowledge/embeddingGeneratorHandler.ts",
  "src/shared/services/openai.service.ts",
  "src/shared/services/azureAiSearch.service.ts",
  "src/functions/knowledge/DocumentSearch.ts",
  "src/shared/handlers/knowledge/documentSearchHandler.ts",
  "src/functions/knowledge/KnowledgeBaseManager.ts",
  "src/shared/handlers/knowledge/knowledgeBaseManagerHandler.ts",
  "src/functions/knowledge/DocumentManager.ts",
  "src/shared/handlers/knowledge/documentManagerHandler.ts",
  "src/functions/conversation/MessageReceiver.ts",
  "src/shared/handlers/conversation/messageReceiverHandler.ts",
  "src/functions/conversation/ContextRetriever.ts",
  "src/shared/handlers/conversation/contextRetrieverHandler.ts",
  "src/functions/conversation/ChatCompletion.ts",
  "src/shared/handlers/conversation/chatCompletionHandler.ts",
  "src/functions/conversation/MessageSender.ts",
  "src/shared/handlers/conversation/messageSenderHandler.ts",
  "src/shared/constants/index.ts",
  "src/shared/models/document.model.ts",
  "src/shared/models/documentProcessor.model.ts",
  "src/shared/models/embedding.model.ts",
  "src/shared/models/search.model.ts",
  "src/shared/models/conversation.model.ts"
)

# Ruta completa de la carpeta de destino
$fullDestPath = Join-Path -Path $PSScriptRoot -ChildPath $destFolder

# Crear la carpeta de destino si no existe
if (-not (Test-Path -Path $fullDestPath -PathType Container)) {
  New-Item -ItemType Directory -Path $fullDestPath | Out-Null
  Write-Host "Carpeta '$destFolder' creada."
} else {
  Write-Host "Carpeta '$destFolder' ya existe."
}

# Copiar cada archivo
Write-Host "Iniciando copia de archivos a '$destFolder'..."
foreach ($filePath in $filesToCopy) {
  $fullSourcePath = Join-Path -Path $PSScriptRoot -ChildPath $filePath
  if (Test-Path -Path $fullSourcePath -PathType Leaf) {
    Copy-Item -Path $fullSourcePath -Destination $fullDestPath
    Write-Host "Copiado: $filePath"
  } else {
    Write-Warning "Archivo no encontrado - $filePath (ruta completa buscada: $fullSourcePath)"
  }
}

Write-Host "-----------------------------------------------------"
Write-Host "Proceso completado."
Write-Host "Los archivos seleccionados deberían estar en la carpeta: $fullDestPath"
Write-Host "Por favor, verifica la carpeta y los mensajes de advertencia si los hubiera."