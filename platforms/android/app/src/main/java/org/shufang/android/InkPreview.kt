package org.shufang.android
import android.graphics.*
import java.io.File
import java.util.UUID

object InkPreview {
    fun write(root:File,ink:PortableInk):File {
        val scale=minOf(1.0,2000/ink.height);val bitmap=Bitmap.createBitmap((1000*scale).toInt().coerceAtLeast(1),(ink.height*scale).toInt().coerceAtLeast(1),Bitmap.Config.ARGB_8888)
        val canvas=Canvas(bitmap);canvas.scale(scale.toFloat(),scale.toFloat());val paint=Paint(Paint.ANTI_ALIAS_FLAG).apply {strokeCap=Paint.Cap.ROUND;strokeJoin=Paint.Join.ROUND}
        ink.validate()
        for(stroke in ink.strokes){paint.color=Color.argb((stroke.color[3]*255).toInt(),(stroke.color[0]*255).toInt(),(stroke.color[1]*255).toInt(),(stroke.color[2]*255).toInt());if(stroke.points.size==1){val point=stroke.points.single();canvas.drawCircle(point.x.toFloat(),point.y.toFloat(),(stroke.width*(.3+.7*point.pressure)/2).toFloat(),paint)};for(i in 1 until stroke.points.size){val a=stroke.points[i-1];val b=stroke.points[i];paint.strokeWidth=(stroke.width*(.3+.7*b.pressure)).toFloat();canvas.drawLine(a.x.toFloat(),a.y.toFloat(),b.x.toFloat(),b.y.toFloat(),paint)}}
        return File(root,"preview-${UUID.randomUUID()}.png").also {file->try {file.outputStream().use {bitmap.compress(Bitmap.CompressFormat.PNG,100,it)}}finally {bitmap.recycle()}}
    }
}
