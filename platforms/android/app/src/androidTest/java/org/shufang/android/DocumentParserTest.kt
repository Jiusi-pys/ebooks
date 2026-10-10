package org.shufang.android

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.nio.ByteBuffer
import java.nio.ByteOrder

@RunWith(AndroidJUnit4::class)
class DocumentParserTest {
    private fun parse(name:String,bytes:ByteArray,mode:String="reflow",failure:Boolean=false):JSONObject {
        val instrumentation=InstrumentationRegistry.getInstrumentation()
        val context=instrumentation.targetContext
        val source=File(context.cacheDir,"parser-${UUID.randomUUID()}").apply {writeBytes(bytes)}
        val scope=CoroutineScope(SupervisorJob()+Dispatchers.Main)
        val ready=CountDownLatch(1);val finished=CountDownLatch(1)
        lateinit var view:DocumentWebView;var result=JSONObject()
        instrumentation.runOnMainSync {view=DocumentWebView(context,scope){event->
            when(event.optString("type")) {
                "ready"->ready.countDown()
                "parsedEnd"->{result=JSONObject(File(event.getString("parsedPath")).readText());finished.countDown()}
                "failure"->{result=event;finished.countDown()}
            }
        }}
        try {
            assertTrue("Local parser did not start",ready.await(30,TimeUnit.SECONDS))
            instrumentation.runOnMainSync {view.javascript("importFile",view.resource(source),name,mode)}
            assertTrue("Parser timed out for $name",finished.await(60,TimeUnit.SECONDS))
            if(failure)assertEquals("failure",result.optString("type"))else assertFalse(result.toString(),result.has("error"))
            return result
        }finally {instrumentation.runOnMainSync {view.destroy()};scope.cancel();source.delete()}
    }
    @Test fun localTxtAndFb2ParsersRunOfflineInActualWebView() {
        val txt=parse("离线.txt","第一章\n\n中文正文 🚀\n第二段。".toByteArray())
        assertTrue(txt.getJSONArray("chapters").toString().contains("中文正文 🚀"))
        val fb2=parse("test.fb2","""<?xml version="1.0" encoding="UTF-8"?><FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><description><title-info><book-title>FB2 样例</book-title><author><first-name>作者</first-name></author><lang>zh</lang></title-info></description><body><section><title><p>章节</p></title><p>离线 FB2 正文</p></section></body></FictionBook>""".toByteArray())
        assertEquals("FB2 样例",fb2.getString("title"))
        assertTrue(fb2.getJSONArray("chapters").toString().contains("离线 FB2 正文"))
    }
    @Test fun corruptContainersAndEmptyTextFailWithoutCreatingBooks() {
        for(extension in listOf("pdf","epub","mobi","azw","azw3","fb2"))parse("corrupt.$extension",byteArrayOf(1,2,3),failure=true)
        parse("empty.txt",byteArrayOf(),failure=true)
        parse("unsupported.kfx",byteArrayOf(1,2,3),failure=true)
    }
    @Test fun mobiAzwAndAzw3UseTheSharedParserAndRejectDrm() {
        fun envelope(encryption:Int=0):ByteArray {
            val offset=96;val textOffset=offset+248;val text="<h1>Android MOBI</h1><p>Offline original text</p>".toByteArray()
            val bytes=ByteArray(textOffset+text.size);val buffer=ByteBuffer.wrap(bytes).order(ByteOrder.BIG_ENDIAN)
            "BOOKMOBI".toByteArray().copyInto(bytes,60);buffer.putShort(76,2);buffer.putInt(78,offset);buffer.putInt(86,textOffset)
            buffer.putShort(offset,1);buffer.putInt(offset+4,text.size);buffer.putShort(offset+8,1);buffer.putShort(offset+10,4096);buffer.putShort(offset+12,encryption.toShort())
            "MOBI".toByteArray().copyInto(bytes,offset+16);buffer.putInt(offset+20,116);buffer.putInt(offset+28,65001);buffer.putInt(offset+36,6)
            buffer.putInt(offset+108,2);buffer.putInt(offset+128,64);buffer.putInt(offset+244,-1)
            "EXTH".toByteArray().copyInto(bytes,offset+132);buffer.putInt(offset+136,12);buffer.putInt(offset+140,0);text.copyInto(bytes,textOffset)
            return bytes
        }
        for(extension in listOf("mobi","azw")) {
            val parsed=parse("sample.$extension",envelope())
            assertTrue(parsed.toString(),parsed.getJSONArray("chapters").toString().contains("Offline original text"))
        }
        val kf8=InstrumentationRegistry.getInstrumentation().context.assets.open("sample-kf8.azw3").use {it.readBytes()}
        assertTrue(parse("sample.azw3",kf8).getJSONArray("chapters").length()>0)
        parse("drm.mobi",envelope(2),failure=true)
        parse("broken.azw3",byteArrayOf(1,2,3),failure=true)
    }
    @Test fun epubUsesTheSameWebFixture() {
        val fixture=InstrumentationRegistry.getInstrumentation().context.assets.open("epub-editor.epub").use {it.readBytes()}
        val book=parse("epub-editor.epub",fixture)
        assertTrue(book.getJSONArray("chapters").length()>0)
    }
    @Test fun pdfOriginalAndReflowUseTheBundledWorker() {
        val content="BT /F1 18 Tf 48 700 Td (Offline PDF example) Tj ET"
        val objects=listOf("<< /Type /Catalog /Pages 2 0 R >>","<< /Type /Pages /Kids [3 0 R] /Count 1 >>","<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>","<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>","<< /Length ${content.length} >>\nstream\n$content\nendstream")
        val output=StringBuilder("%PDF-1.4\n");val offsets=mutableListOf(0)
        objects.forEachIndexed {index,value->offsets.add(output.length);output.append("${index+1} 0 obj\n$value\nendobj\n")}
        val xref=output.length;output.append("xref\n0 ${objects.size+1}\n0000000000 65535 f \n")
        offsets.drop(1).forEach {output.append("%010d 00000 n \n".format(it))}
        output.append("trailer\n<< /Size ${objects.size+1} /Root 1 0 R >>\nstartxref\n$xref\n%%EOF")
        val bytes=output.toString().toByteArray(Charsets.US_ASCII)
        assertEquals(1,parse("sample.pdf",bytes,"original").getInt("pageCount"))
        assertTrue(parse("sample.pdf",bytes).getJSONArray("chapters").toString().contains("Offline PDF example"))
        parse("broken.pdf",byteArrayOf(1,2,3),failure=true)
    }
}
