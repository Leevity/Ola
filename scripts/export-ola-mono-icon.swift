import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

// Use the same ola outline as the Android monochrome icon. macOS template
// images require transparent negative space rather than a filled app tile.
let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
for scale in [1, 2] {
  let width = 32 * scale
  let height = 18 * scale
  guard let context = CGContext(data: nil, width: width, height: height,
    bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { fatalError("Cannot create icon context") }
  context.translateBy(x: 0, y: CGFloat(height))
  context.scaleBy(x: CGFloat(width) / 72, y: -CGFloat(width) / 72)
  context.setStrokeColor(CGColor(gray: 0, alpha: 1))
  context.setLineWidth(7)
  context.setLineCap(.round)
  context.setLineJoin(.round)
  context.addEllipse(in: CGRect(x: 4, y: 10, width: 20, height: 20))
  context.move(to: CGPoint(x: 33, y: 4))
  context.addLine(to: CGPoint(x: 33, y: 30))
  context.addEllipse(in: CGRect(x: 44, y: 10, width: 20, height: 20))
  context.move(to: CGPoint(x: 64, y: 11))
  context.addLine(to: CGPoint(x: 64, y: 30))
  context.strokePath()
  let name = scale == 1 ? "trayTemplate.png" : "trayTemplate@2x.png"
  let url = directory.appendingPathComponent(name)
  guard let image = context.makeImage(),
    let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)
    else { fatalError("Cannot create PNG output") }
  CGImageDestinationAddImage(destination, image, nil)
  guard CGImageDestinationFinalize(destination) else { fatalError("Cannot write PNG output") }
}
