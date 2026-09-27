/** Crop only the delivered image. Progress evidence always uses the unmodified
 * window bitmap, so changing crop/scale/grid cannot masquerade as UI progress. */
export const computerUseImageScript = String.raw`
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
public static class CardBushCaptureImage {
  public static void Save(Bitmap source, string path, int x, int y, int width, int height, double scale, bool grid) {
    if(x<0 || y<0 || width<=0 || height<=0 || (long)x+width>source.Width || (long)y+height>source.Height)
      throw new ArgumentException("The screenshot region is outside the captured window.");
    if(Double.IsNaN(scale) || Double.IsInfinity(scale) || scale<1 || scale>3 || Math.Truncate(scale)!=scale)
      throw new ArgumentException("Screenshot scale must be between 1 and 3.");
    int outputWidth=(int)Math.Round(width*scale), outputHeight=(int)Math.Round(height*scale);
    if(outputWidth>8192 || outputHeight>8192 || (long)outputWidth*outputHeight>16000000)
      throw new ArgumentException("The enlarged screenshot exceeds 16 megapixels. Choose a smaller region or scale.");
    if(x==0 && y==0 && width==source.Width && height==source.Height && scale==1 && !grid) {
      source.Save(path,ImageFormat.Png); return;
    }
    using(var result=new Bitmap(outputWidth,outputHeight)) using(var g=Graphics.FromImage(result)) {
      g.InterpolationMode=InterpolationMode.NearestNeighbor;
      g.PixelOffsetMode=PixelOffsetMode.Half;
      g.DrawImage(source,new Rectangle(0,0,outputWidth,outputHeight),new Rectangle(x,y,width,height),GraphicsUnit.Pixel);
      if(grid) using(var pen=new Pen(Color.FromArgb(110,30,115,210)))
        using(var font=new Font(FontFamily.GenericSansSerif,10,FontStyle.Regular,GraphicsUnit.Pixel))
        using(var label=new SolidBrush(Color.FromArgb(210,255,255,255))) {
          for(int wx=(x/50+1)*50;wx<x+width;wx+=50) {
            float px=(float)((wx-x)*scale); g.DrawLine(pen,px,0,px,outputHeight);
            var text=wx.ToString();var size=g.MeasureString(text,font);g.FillRectangle(label,px+1,1,size.Width,size.Height);g.DrawString(text,font,Brushes.Black,px+1,1);
          }
          for(int wy=(y/50+1)*50;wy<y+height;wy+=50) {
            float py=(float)((wy-y)*scale);g.DrawLine(pen,0,py,outputWidth,py);
            var text=wy.ToString();var size=g.MeasureString(text,font);g.FillRectangle(label,1,py+1,size.Width,size.Height);g.DrawString(text,font,Brushes.Black,1,py+1);
          }
        }
      result.Save(path,ImageFormat.Png);
    }
  }
}
'@
`;

export const saveComputerUseImageScript = String.raw`
$imageOptions = if ($script:CARDBUSH_IMAGE_OPTIONS) { $script:CARDBUSH_IMAGE_OPTIONS | ConvertFrom-Json } else { $null }
$imageX=0; $imageY=0; $imageWidth=$width; $imageHeight=$height
$imageScale = if ($null -ne $imageOptions.scale) { [double]$imageOptions.scale } else { 1.0 }
$imageGrid = $imageOptions.grid -eq $true
$regionReset = $false
if ($null -ne $imageOptions.region) {
  $r=$imageOptions.region
  $valid = $r.x -ge 0 -and $r.y -ge 0 -and $r.width -gt 0 -and $r.height -gt 0 -and ([long]$r.x+$r.width) -le $width -and ([long]$r.y+$r.height) -le $height
  $sameWindow = $h.ToInt64() -eq [Int64]$script:CARDBUSH_WINDOW_HWND
  if ($valid -and $sameWindow) { $imageX=[int]$r.x; $imageY=[int]$r.y; $imageWidth=[int]$r.width; $imageHeight=[int]$r.height }
  elseif ($script:CARDBUSH_FOLLOW_OWNED_WINDOW -eq '1') { $regionReset=$true; $imageScale=1.0 }
  else { throw 'The screenshot region is outside the captured window. Observe with a smaller region.' }
}
# Create the directory inside observation, after the action ACK. A storage
# failure must preserve that ACK instead of making completed input ambiguous.
[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($script:CARDBUSH_CAPTURE_PATH))
[CardBushCaptureImage]::Save($bitmap,$script:CARDBUSH_CAPTURE_PATH,$imageX,$imageY,$imageWidth,$imageHeight,$imageScale,$imageGrid)
$imageMapping = [PSCustomObject]@{
  origin=[PSCustomObject]@{x=$imageX;y=$imageY}; scale=$imageScale
  width=[int][Math]::Round($imageWidth*$imageScale); height=[int][Math]::Round($imageHeight*$imageScale)
  source_width=$imageWidth; source_height=$imageHeight; coordinate_space='window'; grid=$imageGrid; region_reset=$regionReset
}
`;
