// Original vector book mark. iOS applies the icon mask; keep the artwork square.
// Run from the repository root: swift ios/scripts/generate-icon.swift
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let output = URL(fileURLWithPath: "ios/Shufang/Assets.xcassets/AppIcon.appiconset", isDirectory: true)
let space = CGColorSpace(name: CGColorSpace.sRGB)!
func color(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat) -> CGColor {
    CGColor(colorSpace: space, components: [r, g, b, 1])!
}
for variant in ["AppIcon", "AppIcon-dark", "AppIcon-tinted"] {
    let context = CGContext(data: nil, width: 1024, height: 1024, bitsPerComponent: 8,
        bytesPerRow: 4096, space: space, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    let dark = variant.hasSuffix("dark"), tinted = variant.hasSuffix("tinted")
    let top = tinted ? color(0.24, 0.24, 0.24) : dark ? color(0.15, 0.19, 0.27) : color(0.20, 0.65, 1)
    let bottom = tinted ? color(0.07, 0.07, 0.07) : dark ? color(0.04, 0.06, 0.11) : color(0.02, 0.30, 0.92)
    context.drawLinearGradient(CGGradient(colorsSpace: space, colors: [bottom, top] as CFArray, locations: [0, 1])!,
        start: CGPoint(x: 512, y: 0), end: CGPoint(x: 512, y: 1024), options: [])
    // Broad, gently curved pages remain recognisable at Home Screen sizes.
    func page(right: Bool) -> CGPath {
        let p = CGMutablePath()
        p.move(to: CGPoint(x: 208, y: 717))
        p.addCurve(to: CGPoint(x: 493, y: 683), control1: CGPoint(x: 294, y: 753), control2: CGPoint(x: 398, y: 750))
        p.addLine(to: CGPoint(x: 493, y: 291))
        p.addCurve(to: CGPoint(x: 221, y: 334), control1: CGPoint(x: 409, y: 344), control2: CGPoint(x: 312, y: 358))
        p.addQuadCurve(to: CGPoint(x: 202, y: 353), control: CGPoint(x: 202, y: 329))
        p.addLine(to: CGPoint(x: 202, y: 700))
        p.addQuadCurve(to: CGPoint(x: 208, y: 717), control: CGPoint(x: 202, y: 713))
        p.closeSubpath()
        var mirror = CGAffineTransform(a: -1, b: 0, c: 0, d: 1, tx: 1024, ty: 0)
        return right ? p.copy(using: &mirror)! : p
    }
    context.setShadow(offset: CGSize(width: 0, height: -12), blur: 20,
                      color: color(0.03, 0.15, 0.4).copy(alpha: dark || tinted ? 0 : 0.15))
    context.setFillColor(dark ? color(0.39, 0.73, 1) : color(1, 1, 1))
    context.addPath(page(right: false)); context.fillPath()
    context.addPath(page(right: true)); context.fillPath()
    context.setShadow(offset: .zero, blur: 0, color: nil)
    // A small bookmark cutout distinguishes the mark without adding small text.
    let ribbon = CGMutablePath()
    ribbon.move(to: CGPoint(x: 693, y: 733)); ribbon.addLine(to: CGPoint(x: 746, y: 733))
    ribbon.addLine(to: CGPoint(x: 746, y: 590)); ribbon.addLine(to: CGPoint(x: 719.5, y: 612))
    ribbon.addLine(to: CGPoint(x: 693, y: 590)); ribbon.closeSubpath()
    context.setFillColor(tinted ? color(0.15, 0.15, 0.15) : dark ? color(0.10, 0.15, 0.23) : color(0.12, 0.51, 0.98))
    context.addPath(ribbon); context.fillPath()
    let image = context.makeImage()!
    let destination = CGImageDestinationCreateWithURL(output.appendingPathComponent(variant + ".png") as CFURL,
        UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, image, nil)
    precondition(CGImageDestinationFinalize(destination))
    print("Generated \(variant).png (1024 × 1024, opaque)")
}
