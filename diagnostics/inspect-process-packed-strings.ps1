param(
    [Parameter(Mandatory = $true)]
    [string]$ProcessName,

    [Parameter(Mandatory = $true)]
    [string]$StartRva,

    [Parameter(Mandatory = $true)]
    [int]$Length,

    [int]$Alignment = 4,

    [int]$MinimumLength = 2
)

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class PackedStringProcessMemoryReader
{
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint access, bool inheritHandle, int processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ReadProcessMemory(
        IntPtr process,
        IntPtr baseAddress,
        byte[] buffer,
        UIntPtr size,
        out UIntPtr bytesRead);

    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr handle);
}
'@

function Convert-HexToInt64 {
    param([string]$Value)

    [Convert]::ToInt64($Value.Trim().Replace('0x', ''), 16)
}

$process = Get-Process -Name $ProcessName -ErrorAction Stop | Select-Object -First 1
$moduleBase = [long]$process.MainModule.BaseAddress
$rva = Convert-HexToInt64 $StartRva
$absoluteStart = $moduleBase + $rva
$handle = [PackedStringProcessMemoryReader]::OpenProcess(0x0410, $false, $process.Id)
if ($handle -eq [IntPtr]::Zero) {
    throw "OpenProcess failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}

$buffer = New-Object byte[] $Length
$bytesRead = [UIntPtr]::Zero
try {
    $success = [PackedStringProcessMemoryReader]::ReadProcessMemory(
        $handle,
        [IntPtr]$absoluteStart,
        $buffer,
        [UIntPtr]::new([uint64]$Length),
        [ref]$bytesRead)
    if (-not $success) {
        throw "ReadProcessMemory failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
} finally {
    [void][PackedStringProcessMemoryReader]::CloseHandle($handle)
}

$actualLength = [int]$bytesRead.ToUInt64()
$results = [Collections.Generic.List[object]]::new()
$index = 0
while ($index -lt $actualLength) {
    if (($index % $Alignment) -ne 0 -or $buffer[$index] -lt 0x20 -or $buffer[$index] -gt 0x7E) {
        $index += 1
        continue
    }

    $end = $index
    while ($end -lt $actualLength -and $buffer[$end] -ge 0x20 -and $buffer[$end] -le 0x7E) {
        $end += 1
    }
    if ($end -lt $actualLength -and $buffer[$end] -eq 0 -and ($end - $index) -ge $MinimumLength) {
        $text = [Text.Encoding]::ASCII.GetString($buffer, $index, $end - $index)
        $results.Add([pscustomobject]@{
            Offset = ('0x{0:X}' -f $index)
            Slot = [int]($index / $Alignment)
            Rva = ('0x{0:X}' -f ($rva + $index))
            Address = ('0x{0:X16}' -f ($absoluteStart + $index))
            Text = $text
        })
        $index = $end + 1
        continue
    }

    $index += 1
}

$results | ConvertTo-Json -Depth 3