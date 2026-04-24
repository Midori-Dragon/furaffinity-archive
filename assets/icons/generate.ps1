$sizes = 16,32,48,64,96,128,180,192,256,512
$inkscape = "C:\Program Files\Inkscape\bin\inkscape.exe"

foreach ($size in $sizes) {
  & $inkscape icon.svg -w $size -h $size -o "icon-x$size.png"
}
