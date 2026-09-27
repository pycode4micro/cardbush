/** Runs inside window capture after UIAutomation assemblies and window bounds
 * are loaded. Querying affects returned controls, never progress evidence. */
export const computerUseAccessibilityScript = String.raw`
function Get-CardBushElementBounds($elementRect) {
  if (-not [double]::IsNaN($elementRect.X) -and -not [double]::IsInfinity($elementRect.X) -and $elementRect.Width -gt 0 -and $elementRect.Height -gt 0) {
    [PSCustomObject]@{ x=[Math]::Round($elementRect.X-$rect.Left); y=[Math]::Round($elementRect.Y-$rect.Top); width=[Math]::Round($elementRect.Width); height=[Math]::Round($elementRect.Height) }
  }
}
function Get-CardBushElementValue($element, [bool]$password) {
  if ($password) { return $null }
  $patternObject = $null
  if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$patternObject)) {
    $value = ([System.Windows.Automation.ValuePattern]$patternObject).Current
    return [PSCustomObject]@{ value=[string]$value.Value; read_only=[bool]$value.IsReadOnly }
  }
  if ($element.TryGetCurrentPattern([System.Windows.Automation.RangeValuePattern]::Pattern, [ref]$patternObject)) {
    $value = ([System.Windows.Automation.RangeValuePattern]$patternObject).Current
    return [PSCustomObject]@{ value=[string]$value.Value; read_only=[bool]$value.IsReadOnly }
  }
}
function Limit-CardBushText([string]$text, [int]$length) {
  if ($text.Length -gt $length) { return $text.Substring(0,$length) }
  return $text
}

# Read the same focused control regardless of include_text, query or page. Do
# not hash the returned tree: filtering it must not appear to be UI progress.
$focusedFingerprint = ''
$focusedBounds = $null
try {
  $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
  if ($null -ne $focused -and -not [CardBushCaptureLayers]::IsLayerOrChild([IntPtr]$focused.Current.NativeWindowHandle)) {
    $ancestor = $focused
    $belongsToTarget = $false
    for ($depth=0; $null -ne $ancestor -and $depth -lt 32; $depth++) {
      if ($ancestor.Current.NativeWindowHandle -eq $h.ToInt64()) { $belongsToTarget=$true; break }
      $ancestor = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($ancestor)
    }
    if ($belongsToTarget) {
      $current = $focused.Current
      $focusedBounds = Get-CardBushElementBounds $current.BoundingRectangle
      $value = Get-CardBushElementValue $focused $current.IsPassword
      $text = [Text.StringBuilder]::new()
      $textPattern = $null
      if (-not $current.IsPassword -and $focused.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern,[ref]$textPattern)) {
        foreach ($range in @(([System.Windows.Automation.TextPattern]$textPattern).GetVisibleRanges() | Select-Object -First 4)) {
          if ($text.Length -ge 32768) { break }
          [void]$text.Append($range.GetText([Math]::Min(8192,32768-$text.Length)))
        }
      }
      $basis = @((@($focused.GetRuntimeId()) -join '.'), (Limit-CardBushText $current.Name 240), (Limit-CardBushText $value.value 32768), $text.ToString()) | ConvertTo-Json -Compress
      $hasher = [Security.Cryptography.SHA256]::Create()
      try { $focusedFingerprint=[Convert]::ToBase64String($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($basis))) }
      finally { $hasher.Dispose() }
    }
  }
} catch { }

$accessibilityAvailable = $false
$accessibilityError = $null
$totalElements = 0
$matchedElements = 0
$scanTruncated = $false
$nextOffset = $null
$elements = [System.Collections.Generic.List[object]]::new()
$elementOffset = [Math]::Max(0,[int]$script:CARDBUSH_ELEMENT_OFFSET)
if ($script:CARDBUSH_INCLUDE_ACCESSIBILITY -eq '1') {
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
    if ($null -eq $root) { throw 'UI Automation could not bind to the target window.' }
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
    $totalElements = $all.Count
    $scanLimit = [Math]::Min(5000,$all.Count)
    $scanTruncated = $scanLimit -lt $all.Count
    $query = $script:CARDBUSH_ELEMENT_QUERY | ConvertFrom-Json
    $candidates = [System.Collections.Generic.List[object]]::new()
    for ($sourceIndex=0; $sourceIndex -lt $scanLimit; $sourceIndex++) {
      try {
        $element=$all.Item($sourceIndex); $current=$element.Current
        if (-not $current.IsControlElement -or ($current.IsOffscreen -and -not $current.HasKeyboardFocus)) { continue }
        if ([CardBushCaptureLayers]::IsLayerOrChild([IntPtr]$current.NativeWindowHandle)) { continue }
        $controlType=([string]$current.ControlType.ProgrammaticName) -replace '^ControlType\.', ''
        if ($query.name -and ([string]$current.Name).IndexOf([string]$query.name,[StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
        if ($query.automation_id -and -not [string]::Equals($current.AutomationId,[string]$query.automation_id,[StringComparison]::OrdinalIgnoreCase)) { continue }
        if ($query.control_type -and -not [string]::Equals($controlType,[string]$query.control_type,[StringComparison]::OrdinalIgnoreCase)) { continue }
        if ($null -ne $query.focused -and $current.HasKeyboardFocus -ne [bool]$query.focused) { continue }
        $priority = if ($current.HasKeyboardFocus) { 0 } elseif ($controlType -in @('Edit','ComboBox')) { 1 } elseif ($controlType -in @('Button','CheckBox','RadioButton')) { 2 } else { 3 }
        $candidates.Add([PSCustomObject]@{ element=$element; source_index=$sourceIndex; priority=$priority })
      } catch { continue }
    }
    # Scan before truncating so a file list cannot bury File name / Open.
    $ordered = @($candidates.ToArray() | Sort-Object priority,source_index)
    $matchedElements=$ordered.Count
    $maxElements=[Math]::Max(20,[Math]::Min(300,[int]$script:CARDBUSH_MAX_ELEMENTS))
    for ($resultOffset=$elementOffset; $resultOffset -lt $ordered.Count -and $elements.Count -lt $maxElements; $resultOffset++) {
      try {
        $candidate=$ordered[$resultOffset]; $element=$candidate.element; $current=$element.Current
        $runtimeId=@($element.GetRuntimeId()) -join '.'
        if (-not $runtimeId) { continue }
        $patterns=@($element.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName -replace 'PatternIdentifiers\.Pattern$', '' } | Where-Object { $_ -in @('Invoke','Toggle','SelectionItem','ExpandCollapse','Value','RangeValue','Text','Scroll','LegacyIAccessible') })
        if (-not $current.Name -and -not $current.AutomationId -and $patterns.Count -eq 0) { continue }
        $value=Get-CardBushElementValue $element $current.IsPassword
        $semanticState=$null; $patternObject=$null
        if ($element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern,[ref]$patternObject)) {
          $semanticState=[string]([System.Windows.Automation.TogglePattern]$patternObject).Current.ToggleState
        } elseif ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern,[ref]$patternObject)) {
          $semanticState=if (([System.Windows.Automation.SelectionItemPattern]$patternObject).Current.IsSelected) { 'selected' } else { 'not_selected' }
        } elseif ($element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$patternObject)) {
          $semanticState=[string]([System.Windows.Automation.ExpandCollapsePattern]$patternObject).Current.ExpandCollapseState
        }
        $elements.Add([PSCustomObject]@{
          index=$candidate.source_index; result_offset=$resultOffset; runtime_id=$runtimeId
          name=(Limit-CardBushText $current.Name 240); automation_id=(Limit-CardBushText $current.AutomationId 160)
          control_type=(([string]$current.ControlType.ProgrammaticName) -replace '^ControlType\.', ''); class_name=(Limit-CardBushText $current.ClassName 120)
          enabled=[bool]$current.IsEnabled; focused=[bool]$current.HasKeyboardFocus; offscreen=[bool]$current.IsOffscreen; password=[bool]$current.IsPassword
          bounds=(Get-CardBushElementBounds $current.BoundingRectangle); patterns=$patterns
          value=$(if ($null -ne $value) { Limit-CardBushText $value.value 800 } else { $null }); state=$semanticState; read_only=$value.read_only
        })
      } catch { continue }
    }
    if ($resultOffset -lt $ordered.Count) { $nextOffset=$resultOffset }
    $accessibilityAvailable=$true
  } catch { $accessibilityError=$_.Exception.Message }
}
`;
