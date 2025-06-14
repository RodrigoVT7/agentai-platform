# Nombre de la carpeta de destino
$destFolder = "sistema_principal_archivos_planos"

# Lista de archivos a copiar
$filesToCopy = @(
    "src/index.ts",
    "src/functions/auth/UserLogin.ts",
    "src/shared/handlers/auth/googleAuthHandler.ts",
    "src/shared/utils/jwt.service.ts",
    "src/functions/conversation/MessageReceiver.ts",
    "src/functions/conversation/ContextRetriever.ts",
    "src/functions/conversation/ChatCompletion.ts",
    "src/functions/conversation/MessageSender.ts",
    "src/functions/agents/AgentCreate.ts",
    "src/functions/agents/AgentDetails.ts",
    "src/functions/agents/AgentUpdate.ts",
    "src/functions/knowledge/DocumentUpload.ts",
    "src/functions/knowledge/DocumentProcessor.ts",
    "src/functions/knowledge/EmbeddingGenerator.ts",
    "src/functions/knowledge/DocumentSearch.ts",
    "src/functions/integrations/IntegrationExecutor.ts",
    "src/shared/handlers/integrations/googleCalendarHandler.ts",
    "src/shared/handlers/integrations/whatsAppIntegrationHandler.ts",
    "src/shared/services/storage.service.ts",
    "src/shared/services/openai.service.ts"
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