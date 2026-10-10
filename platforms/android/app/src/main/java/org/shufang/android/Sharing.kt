package org.shufang.android

import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import java.io.File
import java.util.UUID

object Sharing {
    fun text(context:Context,title:String,text:String) {
        context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_SUBJECT,title).putExtra(Intent.EXTRA_TEXT,text),"分享内容").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
    fun file(context:Context,source:File,name:String,mime:String) {
        val dir=File(context.cacheDir,"shares/${UUID.randomUUID()}").apply {mkdirs()}
        val safe=name.replace(Regex("[\\\\/:*?\"<>|]"),"_").ifBlank {"book"}
        val copy=File(dir,safe);source.inputStream().use {input->copy.outputStream().use {input.copyTo(it)}}
        val uri=FileProvider.getUriForFile(context,"${BuildConfig.APPLICATION_ID}.files",copy)
        context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM,uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),"分享原文件").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
