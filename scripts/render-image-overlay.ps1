param(
  [Parameter(Mandatory = $true)]
  [string]$RequestPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

Add-Type -AssemblyName System.Drawing

$request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$sourceImage = [System.Drawing.Image]::FromFile([string]$request.inputPath)
$outputImage = $null
$graphics = $null

function New-OverlayFont {
  param(
    [double]$Size,
    [System.Drawing.FontStyle]$Style = [System.Drawing.FontStyle]::Regular
  )

  foreach ($family in @("Microsoft YaHei UI", "Microsoft YaHei", "SimHei", "Arial")) {
    try {
      return [System.Drawing.Font]::new($family, [single]$Size, $Style, [System.Drawing.GraphicsUnit]::Pixel)
    } catch {
      continue
    }
  }
  return [System.Drawing.Font]::new("Arial", [single]$Size, $Style, [System.Drawing.GraphicsUnit]::Pixel)
}

function New-OverlayBrush {
  param([int]$Alpha, [int]$Red, [int]$Green, [int]$Blue)
  return [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb($Alpha, $Red, $Green, $Blue))
}

function Get-FittedFont {
  param(
    [string]$Text,
    [double]$MaxWidth,
    [double]$MaxSize,
    [double]$MinSize,
    [System.Drawing.FontStyle]$Style = [System.Drawing.FontStyle]::Bold
  )

  for ($size = $MaxSize; $size -ge $MinSize; $size -= 2) {
    $font = New-OverlayFont -Size $size -Style $Style
    $measured = $graphics.MeasureString($Text, $font)
    if ($measured.Width -le $MaxWidth) {
      return $font
    }
    $font.Dispose()
  }
  return New-OverlayFont -Size $MinSize -Style $Style
}

function Draw-WrappedText {
  param(
    [string]$Text,
    [System.Drawing.Font]$Font,
    [System.Drawing.Brush]$Brush,
    [double]$X,
    [double]$Y,
    [double]$MaxWidth,
    [double]$LineHeight,
    [int]$MaxLines
  )

  $remaining = (($Text -replace "\s+", " ").Trim()).ToCharArray()
  if ($remaining.Length -eq 0) {
    return
  }

  $line = ""
  $lineIndex = 0
  $cursor = 0
  while ($cursor -lt $remaining.Length -and $lineIndex -lt $MaxLines) {
    $candidate = $line + [string]$remaining[$cursor]
    if ($line.Length -gt 0 -and $graphics.MeasureString($candidate, $Font).Width -gt $MaxWidth) {
      $graphics.DrawString($line, $Font, $Brush, [single]$X, [single]($Y + $lineIndex * $LineHeight))
      $line = [string]$remaining[$cursor]
      $lineIndex += 1
    } else {
      $line = $candidate
    }
    $cursor += 1
  }

  if ($line.Length -gt 0 -and $lineIndex -lt $MaxLines) {
    if ($cursor -lt $remaining.Length) {
      $line = $line.TrimEnd() + "..."
    }
    $graphics.DrawString($line, $Font, $Brush, [single]$X, [single]($Y + $lineIndex * $LineHeight))
  }
}

try {
  $width = $sourceImage.Width
  $height = $sourceImage.Height
  $scale = [Math]::Max(0.65, $height / 1024.0)
  $topHeight = [int][Math]::Round(190 * $scale)
  $bottomHeight = [int][Math]::Round(250 * $scale)
  $margin = [double](48 * $scale)

  $outputImage = [System.Drawing.Bitmap]::new(
    $width,
    $height,
    [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
  )
  $graphics = [System.Drawing.Graphics]::FromImage($outputImage)
  $graphics.DrawImage($sourceImage, 0, 0, $width, $height)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit

  $darkPanel = New-OverlayBrush 255 20 29 27
  $lightPanel = New-OverlayBrush 255 249 247 240
  $accent = New-OverlayBrush 255 221 244 91
  $ink = New-OverlayBrush 255 27 36 34
  $muted = New-OverlayBrush 255 108 117 112
  $white = New-OverlayBrush 255 255 255 255
  $whiteMuted = New-OverlayBrush 210 230 235 232
  $warm = New-OverlayBrush 255 151 92 43
  $lineBrush = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(80, 24, 33, 31), [single](1.5 * $scale))

  $graphics.FillRectangle($darkPanel, 0, 0, $width, $topHeight)
  $graphics.FillRectangle($lightPanel, 0, $height - $bottomHeight, $width, $bottomHeight)
  $graphics.FillRectangle($accent, [int]$margin, [int](28 * $scale), [int](7 * $scale), [int](114 * $scale))
  $graphics.DrawLine($lineBrush, 0, $height - $bottomHeight, $width, $height - $bottomHeight)

  $eyebrowFont = New-OverlayFont -Size (15 * $scale) -Style ([System.Drawing.FontStyle]::Bold)
  $titleText = ([string]$request.productName).Trim()
  if (-not $titleText) {
    $titleText = "产品说明示意图"
  }
  $titleText = "$titleText / 产品说明示意图"
  $titleFont = Get-FittedFont -Text $titleText -MaxWidth ($width - 2 * $margin - 92 * $scale) -MaxSize (46 * $scale) -MinSize (28 * $scale)
  $metaFont = New-OverlayFont -Size (16 * $scale) -Style ([System.Drawing.FontStyle]::Bold)

  $graphics.DrawString("FDEX / PRODUCT FIELD GUIDE", $eyebrowFont, $accent, [single]($margin + 20 * $scale), [single](32 * $scale))
  $graphics.DrawString($titleText, $titleFont, $white, [single]($margin + 20 * $scale), [single](65 * $scale))
  $graphics.DrawString("示意底图由 Image Provider 生成，文字与参数由本地排版层绘制", $eyebrowFont, $whiteMuted, [single]($margin + 20 * $scale), [single](139 * $scale))

  $rightFormat = [System.Drawing.StringFormat]::new()
  $rightFormat.Alignment = [System.Drawing.StringAlignment]::Far
  $graphics.DrawString("LIVE / REVIEW REQUIRED", $metaFont, $warm, [single]($width - $margin), [single](38 * $scale), $rightFormat)
  $graphics.DrawString(([string]$request.layout), $eyebrowFont, $whiteMuted, [single]($width - $margin), [single](68 * $scale), $rightFormat)

  $panelTop = $height - $bottomHeight
  $headingY = $panelTop + 34 * $scale
  $bodyY = $panelTop + 78 * $scale
  $headingFont = New-OverlayFont -Size (14 * $scale) -Style ([System.Drawing.FontStyle]::Bold)
  $bodyFont = New-OverlayFont -Size (18 * $scale) -Style ([System.Drawing.FontStyle]::Regular)
  $bodyBold = New-OverlayFont -Size (18 * $scale) -Style ([System.Drawing.FontStyle]::Bold)
  $smallFont = New-OverlayFont -Size (14 * $scale) -Style ([System.Drawing.FontStyle]::Regular)

  $columnX = @(
    [double]$margin,
    [double]($width * 0.255),
    [double]($width * 0.49),
    [double]($width * 0.73)
  )
  $columnWidth = @(
    [double]($width * 0.19),
    [double]($width * 0.2),
    [double]($width * 0.2),
    [double]($width * 0.2)
  )

  $graphics.DrawString("外形尺寸", $headingFont, $muted, [single]$columnX[0], [single]$headingY)
  $dimensionLines = @($request.dimensionLines)
  for ($index = 0; $index -lt [Math]::Min(3, $dimensionLines.Count); $index++) {
    $graphics.DrawString([string]$dimensionLines[$index], $bodyBold, $ink, [single]$columnX[0], [single]($bodyY + $index * 28 * $scale))
  }

  $graphics.DrawString("本体材质", $headingFont, $muted, [single]$columnX[1], [single]$headingY)
  Draw-WrappedText -Text ([string]$request.material) -Font $bodyFont -Brush $ink -X $columnX[1] -Y $bodyY -MaxWidth $columnWidth[1] -LineHeight (25 * $scale) -MaxLines 4

  $graphics.DrawString("固定方式", $headingFont, $muted, [single]$columnX[2], [single]$headingY)
  Draw-WrappedText -Text ([string]$request.mounting) -Font $bodyFont -Brush $ink -X $columnX[2] -Y $bodyY -MaxWidth $columnWidth[2] -LineHeight (25 * $scale) -MaxLines 4

  $graphics.DrawString("资料要点", $headingFont, $muted, [single]$columnX[3], [single]$headingY)
  Draw-WrappedText -Text ([string]$request.labelsText) -Font $bodyBold -Brush $ink -X $columnX[3] -Y $bodyY -MaxWidth $columnWidth[3] -LineHeight (25 * $scale) -MaxLines 2
  Draw-WrappedText -Text ([string]$request.unknownsText) -Font $smallFont -Brush $warm -X $columnX[3] -Y ($bodyY + 58 * $scale) -MaxWidth $columnWidth[3] -LineHeight (21 * $scale) -MaxLines 2

  $footerY = $height - 25 * $scale
  $graphics.DrawString("示意图，不作为施工或承载校核；文字与尺寸须人工复核", $smallFont, $muted, [single]$margin, [single]$footerY)
  $sourceText = ([string]$request.sourceNote).Trim()
  if ($sourceText.Length -gt 0) {
    $graphics.DrawString($sourceText, $smallFont, $muted, [single]($width - $margin), [single]$footerY, $rightFormat)
  }

  $outputImage.Save([string]$request.outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output ([string]$request.outputPath)
}
finally {
  if ($graphics) { $graphics.Dispose() }
  if ($outputImage) { $outputImage.Dispose() }
  $sourceImage.Dispose()
}
