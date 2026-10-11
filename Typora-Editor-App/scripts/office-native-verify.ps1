param(
  [ValidateSet('docx','table','image')][string]$Mode='docx',
  [ValidateSet('all','word','excel','powerpoint')][string]$App='all',
  [string]$Source
)
$ErrorActionPreference='Stop'
$outputRoot=[System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../.perf/media-office-1.0.15/office-native'))
[System.IO.Directory]::CreateDirectory($outputRoot) | Out-Null
$stamp=$Mode; if ($App -ne 'all') { $stamp="$Mode-$App" }
$results=[ordered]@{mode=$Mode; app=$App}
# Every step logs to stdout immediately: when the harness timeout kills this
# process, the collected stdout pinpoints which COM call never returned.
function Log([string]$message) { [Console]::Out.WriteLine("[$(Get-Date -Format HH:mm:ss.fff)] $message"); [Console]::Out.Flush() }
function Release-Com($value) { if ($null -ne $value -and [Runtime.InteropServices.Marshal]::IsComObject($value)) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($value) } }
function Get-Pids([string]$name) { @(Get-Process -Name $name -ErrorAction SilentlyContinue | ForEach-Object { [int]$_.Id }) }
# Create an Office COM server and persist the PIDs it spawned so the harness
# can taskkill exactly those processes (never a user's own instance) if a COM
# call hangs past the timeout and this script is killed before its finally.
function Start-Office([string]$progId) {
  $exe=@{ 'Word.Application'='WINWORD'; 'Excel.Application'='EXCEL'; 'PowerPoint.Application'='POWERPNT' }[$progId]
  $before=Get-Pids $exe
  Log "$progId launching (pre-existing pids: $($before -join ','))"
  $com=New-Object -ComObject $progId
  $after=Get-Pids $exe
  $fresh=@($after | Where-Object { $before -notcontains $_ })
  ConvertTo-Json -InputObject $fresh -Compress | Set-Content -LiteralPath (Join-Path $outputRoot ($stamp+'-pids.json')) -Encoding ascii
  Log "$progId ready (spawned pids: $($fresh -join ','))"
  return $com
}
if ($Mode -ne 'docx') {
  [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()
  # NOTE: do NOT call [Clipboard]::GetDataObject() here. On this STA thread it
  # holds an IDataObject that turns PowerShell into a delayed-render owner; Word
  # then blocks in SaveAs2 waiting for a render reply this script never pumps.
  # The clip owner (App main / bridge) already writes owner-free HGLOBAL data.
}
$runWord = ($Mode -eq 'docx') -or ($Mode -eq 'image' -and $App -in 'all','word')
$runExcel = ($Mode -eq 'table') -or ($Mode -eq 'image' -and $App -in 'all','excel')
$runPowerPoint = ($Mode -eq 'image' -and $App -in 'all','powerpoint')
if ($runWord) {
  $word=$null; $document=$null; $owned=$false
  try {
    $word=Start-Office 'Word.Application'
    if ($word.Documents.Count -ne 0) { throw 'Refusing to use a Word instance with existing documents' }
    $owned=$true; Log 'word: hiding window'; $word.Visible=$false; $word.DisplayAlerts=0
    if ($Mode -eq 'docx') {
      $sourcePath=[System.IO.Path]::GetFullPath($Source)
      Log 'word: opening source document'; $document=$word.Documents.Open($sourcePath,$false,$true,$false)
      $results.formulas=$document.OMaths.Count; $results.tables=$document.Tables.Count; $results.images=$document.InlineShapes.Count
      $results.pages=$document.ComputeStatistics(2)
      [string]$pdf=[System.IO.Path]::Combine($outputRoot,'word-quality.pdf')
      [System.IO.File]::Delete($pdf)
      Log 'word: exporting PDF'; $document.ExportAsFixedFormat($pdf,17); $results.pdf=$pdf
    } else {
      Log 'word: adding document'; $document=$word.Documents.Add()
      Log 'word: pasting from clipboard'; $document.Range().Paste(); Log 'word: paste returned'
      $results.wordImages=$document.InlineShapes.Count; Log ("word: InlineShapes.Count=" + $results.wordImages)
      if ($results.wordImages -ne 1) { throw 'Word did not paste one native embedded image' }
      # Cmdlet output such as Join-Path carries a PSObject wrapper. Passing that
      # wrapper directly to Office COM can open a hidden Save As prompt forever.
      # A typed .NET string keeps automation non-interactive and repeatable.
      [string]$wordOutput=[System.IO.Path]::Combine($outputRoot,'image-word.docx')
      [System.IO.File]::Delete($wordOutput)
      Log 'word: SaveAs2 docx'; $document.SaveAs2($wordOutput,16); Log 'word: saved'
    }
  } catch { Log ("word: error: " + $_.Exception.Message); throw } finally {
    if ($document) { $document.Close(0); Release-Com $document }
    if ($owned -and $word -and $word.Documents.Count -eq 0) { $word.Quit() }
    Release-Com $word; Log 'word: released'
  }
}
if ($runExcel) {
  $excel=$null; $workbook=$null; $sheet=$null; $owned=$false
  try {
    $excel=Start-Office 'Excel.Application'
    if ($excel.Workbooks.Count -ne 0) { throw 'Refusing to use an Excel instance with existing workbooks' }
    $owned=$true; Log 'excel: hiding window'; $excel.Visible=$false; $excel.DisplayAlerts=$false
    Log 'excel: adding workbook'; $workbook=$excel.Workbooks.Add(); $sheet=$workbook.Worksheets.Item(1)
    Log 'excel: pasting from clipboard'; $sheet.Paste($sheet.Range('A1')); Log 'excel: paste returned'
    if ($Mode -eq 'table') {
      $results.rows=$sheet.UsedRange.Rows.Count; $results.columns=$sheet.UsedRange.Columns.Count
      $results.leadingZeros=[string]$sheet.Cells.Item(2,1).Value2; $results.formulaText=[string]$sheet.Cells.Item(2,2).Value2; $results.hasFormula=[bool]$sheet.Cells.Item(2,2).HasFormula
      $results.chinese=[string]$sheet.Cells.Item(3,1).Value2
      $chineseOk=$results.chinese.Length -eq 2 -and [int]$results.chinese[0] -eq 0x4e2d -and [int]$results.chinese[1] -eq 0x6587
      if ($results.leadingZeros -ne '00123' -or $results.formulaText -ne '=1+1' -or $results.hasFormula -or !$chineseOk) { throw ('Excel changed literal cells: '+($results|ConvertTo-Json -Compress)) }
      [string]$excelOutput=[System.IO.Path]::Combine($outputRoot,'table-excel.xlsx')
      [System.IO.File]::Delete($excelOutput)
      Log 'excel: SaveAs xlsx'; $workbook.SaveAs($excelOutput,51)
    } else {
      $results.excelImages=$sheet.Shapes.Count; Log ("excel: Shapes.Count=" + $results.excelImages)
      if ($results.excelImages -ne 1) { throw 'Excel did not paste one embedded image' }
      [string]$excelOutput=[System.IO.Path]::Combine($outputRoot,'image-excel.xlsx')
      [System.IO.File]::Delete($excelOutput)
      Log 'excel: SaveAs xlsx'; $workbook.SaveAs($excelOutput,51); Log 'excel: saved'
    }
  } catch { Log ("excel: error: " + $_.Exception.Message); throw } finally {
    Release-Com $sheet
    if ($workbook) { $workbook.Close($false); Release-Com $workbook }
    if ($owned -and $excel -and $excel.Workbooks.Count -eq 0) { $excel.Quit() }
    Release-Com $excel; Log 'excel: released'
  }
}
if ($runPowerPoint) {
  $powerpoint=$null; $presentation=$null; $slide=$null; $owned=$false
  try {
    $powerpoint=Start-Office 'PowerPoint.Application'
    if ($powerpoint.Presentations.Count -ne 0) { throw 'Refusing to use a PowerPoint instance with existing presentations' }
    $owned=$true
    Log 'powerpoint: adding presentation'; $presentation=$powerpoint.Presentations.Add(0); $slide=$presentation.Slides.Add(1,12)
    Log 'powerpoint: pasting from clipboard'; $shapes=$slide.Shapes.Paste(); Log 'powerpoint: paste returned'
    $results.powerpointImages=$shapes.Count; Log ("powerpoint: Shapes.Count=" + $results.powerpointImages); Release-Com $shapes
    if ($results.powerpointImages -ne 1) { throw 'PowerPoint did not paste one embedded image' }
    [string]$powerpointOutput=[System.IO.Path]::Combine($outputRoot,'image-powerpoint.pptx')
    [System.IO.File]::Delete($powerpointOutput)
    Log 'powerpoint: SaveAs pptx'; $presentation.SaveAs($powerpointOutput,24); Log 'powerpoint: saved'
  } catch { Log ("powerpoint: error: " + $_.Exception.Message); throw } finally {
    Release-Com $slide
    if ($presentation) { $presentation.Close(); Release-Com $presentation }
    if ($owned -and $powerpoint -and $powerpoint.Presentations.Count -eq 0) { $powerpoint.Quit() }
    Release-Com $powerpoint; Log 'powerpoint: released'
  }
}
$results | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $outputRoot ($stamp+'-result.json')) -Encoding utf8
$results | ConvertTo-Json
