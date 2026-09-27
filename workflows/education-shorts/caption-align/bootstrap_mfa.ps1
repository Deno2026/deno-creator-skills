[CmdletBinding()]
param(
    [string]$RuntimeRoot = (Join-Path $PSScriptRoot '.runtime'),
    [string]$MicromambaVersion = '2.3.2'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$runtimePath = [System.IO.Path]::GetFullPath($RuntimeRoot)
$micromambaPath = Join-Path $runtimePath 'micromamba.exe'
$mambaRoot = Join-Path $runtimePath 'mamba-root'
$environmentPath = Join-Path $runtimePath 'env'
$mfaRoot = Join-Path $runtimePath 'mfa-root'
$downloadPath = Join-Path $runtimePath "micromamba-$MicromambaVersion.tar.bz2"
$extractPath = Join-Path $runtimePath 'micromamba-extract'

New-Item -ItemType Directory -Force -Path $runtimePath,$mambaRoot,$mfaRoot | Out-Null

if (-not (Test-Path -LiteralPath $micromambaPath -PathType Leaf)) {
    $downloadUrl = "https://micro.mamba.pm/api/micromamba/win-64/$MicromambaVersion"
    Write-Host "Downloading micromamba $MicromambaVersion..."
    Invoke-WebRequest -Uri $downloadUrl -OutFile $downloadPath -UseBasicParsing
    New-Item -ItemType Directory -Force -Path $extractPath | Out-Null
    & tar.exe -xjf $downloadPath -C $extractPath
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to extract micromamba archive: $downloadPath"
    }
    $extractedBinary = Join-Path $extractPath 'Library\bin\micromamba.exe'
    if (-not (Test-Path -LiteralPath $extractedBinary -PathType Leaf)) {
        throw "micromamba.exe was not present in the downloaded archive"
    }
    Copy-Item -LiteralPath $extractedBinary -Destination $micromambaPath
    Remove-Item -LiteralPath $downloadPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $extractPath -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host 'Creating the pinned Python 3.11 / MFA 3.4.2 environment...'
& $micromambaPath create -y -r $mambaRoot -p $environmentPath -c conda-forge `
    'python=3.11' 'montreal-forced-aligner=3.4.2' ffmpeg pip
if ($LASTEXITCODE -ne 0) {
    throw 'micromamba environment creation failed'
}

$pythonPath = Join-Path $environmentPath 'python.exe'
$mfaPath = Join-Path $environmentPath 'Scripts\mfa.exe'
$libraryBin = Join-Path $environmentPath 'Library\bin'
$sndfilePath = Join-Path $libraryBin 'sndfile.dll'
$libsndfilePath = Join-Path $libraryBin 'libsndfile.dll'

& $pythonPath -m pip install --disable-pip-version-check `
    'python-mecab-ko==1.3.7' 'jamo==0.4.1'
if ($LASTEXITCODE -ne 0) {
    throw 'Korean tokenizer dependency installation failed'
}

# On Windows, soundfile asks for libsndfile.dll while some conda builds expose
# the same binary only as sndfile.dll.  Keep both names inside this local env.
if ((Test-Path -LiteralPath $sndfilePath -PathType Leaf) -and `
    -not (Test-Path -LiteralPath $libsndfilePath -PathType Leaf)) {
    Copy-Item -LiteralPath $sndfilePath -Destination $libsndfilePath
}

$previousPath = $env:PATH
$previousMfaRoot = $env:MFA_ROOT_DIR
try {
    $env:MFA_ROOT_DIR = $mfaRoot
    $env:PATH = "$libraryBin;$(Join-Path $environmentPath 'Scripts');$environmentPath;$previousPath"

    $version = (& $mfaPath version | Select-Object -Last 1).Trim()
    if ($LASTEXITCODE -ne 0 -or $version -ne '3.4.2') {
        throw "Expected MFA 3.4.2, found '$version'"
    }

    & $mfaPath model download acoustic korean_mfa
    if ($LASTEXITCODE -ne 0) { throw 'Korean acoustic model download failed' }
    & $mfaPath model download dictionary korean_mfa
    if ($LASTEXITCODE -ne 0) { throw 'Korean dictionary download failed' }
    & $mfaPath model download g2p korean_mfa
    if ($LASTEXITCODE -ne 0) { throw 'Korean G2P model download failed' }

    & $pythonPath -c "import soundfile; from mecab import MeCab; import jamo; print('runtime imports: OK')"
    if ($LASTEXITCODE -ne 0) { throw 'Runtime import smoke test failed' }
}
finally {
    $env:PATH = $previousPath
    if ($null -eq $previousMfaRoot) {
        Remove-Item Env:MFA_ROOT_DIR -ErrorAction SilentlyContinue
    }
    else {
        $env:MFA_ROOT_DIR = $previousMfaRoot
    }
}

Write-Host "Caption alignment runtime is ready: $environmentPath"
Write-Host "MFA model root: $mfaRoot"
