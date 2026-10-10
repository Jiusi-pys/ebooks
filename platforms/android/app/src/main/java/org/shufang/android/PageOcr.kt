package org.shufang.android

import android.graphics.BitmapFactory
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import kotlinx.coroutines.suspendCancellableCoroutine
import java.io.File
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

object PageOcr {
    suspend fun recognize(file:File):String {
        val options=BitmapFactory.Options().apply {inJustDecodeBounds=true};BitmapFactory.decodeFile(file.path,options)
        require(options.outWidth in 1..8192&&options.outHeight in 1..8192){"OCR 页面尺寸无效"}
        options.inJustDecodeBounds=false;options.inSampleSize=maxOf(1,maxOf(options.outWidth,options.outHeight)/2048)
        val image=BitmapFactory.decodeFile(file.path,options)?:error("无法读取页面图像")
        val client=TextRecognition.getClient(ChineseTextRecognizerOptions.Builder().build())
        return suspendCancellableCoroutine {continuation->
            client.process(InputImage.fromBitmap(image,0)).addOnSuccessListener {if(continuation.isActive)continuation.resume(it.text)}.addOnFailureListener {if(continuation.isActive)continuation.resumeWithException(it)}.addOnCompleteListener {client.close();image.recycle()}
        }
    }
}
