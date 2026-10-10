package org.shufang.android

import android.net.Uri
import android.view.MotionEvent
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.last
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.util.UUID

/** These tests use only the acceptance application's isolated data. */
class IosParityRuntimeTest {
    @Test fun iosEditedInkRemainsEditableOnAndroid():Unit=runBlocking {
        val instrumentation=InstrumentationRegistry.getInstrumentation();val context=instrumentation.targetContext
        val selected=InstrumentationRegistry.getArguments().getString("returnInkPath")
        org.junit.Assume.assumeTrue("Run after the real PencilKit simulator test",selected!=null)
        check(context.packageName.endsWith(".acceptance"))
        val received=PortableInk.decode(JSONObject(File(context.filesDir,selected!!).readText()))
        val original=PortableInk.decode(JSONObject(File(context.filesDir,"android-ink.json").readText()))
        assertEquals(original.strokes.size+1,received.strokes.size);assertEquals(original.strokes.first(),received.strokes.first())
        lateinit var layer:InkLayer
        instrumentation.runOnMainSync {
            layer=InkLayer(context){_,_->};layer.layout(0,0,1000,1400)
            layer.viewport(JSONObject().put("page",1).put("left",0).put("top",0).put("width",1000).put("height",1400).put("windowWidth",1000).put("canonicalHeight",1400).put("rotation",0));layer.load(received);layer.tool="pen"
            for((action,time,x) in listOf(Triple(MotionEvent.ACTION_DOWN,1000L,600f),Triple(MotionEvent.ACTION_UP,1100L,650f))){val event=MotionEvent.obtain(1000,time,action,1,arrayOf(MotionEvent.PointerProperties().apply {id=0;toolType=MotionEvent.TOOL_TYPE_STYLUS}),arrayOf(MotionEvent.PointerCoords().apply {this.x=x;y=600f;pressure=.6f}),0,0,1f,1f,0,0,android.view.InputDevice.SOURCE_STYLUS,0);try {assertTrue(layer.onTouchEvent(event))}finally {event.recycle()}}
            assertEquals(received.strokes.size+1,layer.snapshot()!!.strokes.size);layer.undo();assertEquals(received,layer.snapshot());layer.redo()
        }
        val repo=CoreRepository(context,"ink-return-${UUID.randomUUID()}");repo.open()
        try {val result=layer.snapshot()!!;val file=File(repo.root,"return.json").apply {writeText(result.json().toString())};val attachment=repo.command("putAttachment",JSONObject().put("path",file.path).put("name","return.json").put("type","application/json"));val note=repo.save("notes",null,JSONObject().put("title","跨端返回验收").put("content","").put("pdfPortableInk",attachment));repo.close();repo.open();val resource=repo.command("attachmentResource",JSONObject().put("reference",repo.get("notes",note.id).value.getJSONObject("pdfPortableInk")));assertEquals(result,PortableInk.decode(JSONObject(File(resource.getString("path")).readText())))}finally {repo.close()}
    }
    @Test fun singlePointInkIsPresentInCompatibilityPreview() {
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        val ink=PortableInk(1000.0,1400.0,listOf(InkStroke("dot","pen",listOf(0.0,0.0,0.0,1.0),10.0,listOf(InkPoint(100.0,200.0,1.0,0.0,0.0,0.0)))))
        val file=InkPreview.write(context.cacheDir,ink)
        try {
            val bitmap=android.graphics.BitmapFactory.decodeFile(file.path)
            try {assertTrue("Single point must remain visible in the iOS-compatible preview",android.graphics.Color.alpha(bitmap.getPixel(100,200))>0)}finally {bitmap.recycle()}
        }finally {file.delete()}
    }
    @Test fun stylusEditsRoundTripThroughRealJniAndUndo():Unit=runBlocking {
        val instrumentation=InstrumentationRegistry.getInstrumentation();val context=instrumentation.targetContext
        check(context.packageName.endsWith(".acceptance")) {"Run this test in the isolated acceptance application"}
        val repo=CoreRepository(context,"ink-acceptance-${UUID.randomUUID()}");repo.open()
        try {
            var changed:PortableInk?=null;lateinit var layer:InkLayer
            instrumentation.runOnMainSync {
                layer=InkLayer(context){ink,_->changed=ink};layer.layout(0,0,600,800)
                layer.viewport(JSONObject().put("page",1).put("left",50).put("top",80).put("width",500).put("height",700).put("windowWidth",600).put("canonicalHeight",1400).put("rotation",0))
                layer.load(null);layer.tool="pen"
                var clock=1000L
                fun event(action:Int,x:Float,y:Float,tool:Int):MotionEvent {
                    val properties=MotionEvent.PointerProperties().apply {id=0;toolType=tool}
                    val coordinate=MotionEvent.PointerCoords().apply {this.x=x;this.y=y;pressure=.7f;size=.1f}
                    return MotionEvent.obtain(1000,++clock,action,1,arrayOf(properties),arrayOf(coordinate),0,0,1f,1f,0,0,android.view.InputDevice.SOURCE_STYLUS,0)
                }
                event(MotionEvent.ACTION_DOWN,100f,200f,MotionEvent.TOOL_TYPE_FINGER).useEvent {assertFalse(layer.onTouchEvent(it))}
                event(MotionEvent.ACTION_DOWN,100f,200f,MotionEvent.TOOL_TYPE_STYLUS).useEvent {assertTrue(layer.onTouchEvent(it))}
                event(MotionEvent.ACTION_MOVE,200f,300f,MotionEvent.TOOL_TYPE_STYLUS).useEvent {assertTrue(layer.onTouchEvent(it))}
                event(MotionEvent.ACTION_UP,250f,330f,MotionEvent.TOOL_TYPE_STYLUS).useEvent {assertTrue(layer.onTouchEvent(it))}
            }
            val original=changed!!;assertEquals(1,original.strokes.size);assertEquals(.7,original.strokes.single().points.first().pressure,.0001)
            val file=File(repo.root,"portable.json").apply {writeText(original.json().toString())}
            val reference=repo.command("putAttachment",JSONObject().put("path",file.path).put("name","page.portableink.json").put("type","application/json"))
            val saved=repo.save("notes",null,JSONObject().put("title","笔画验收").put("content","").put("pdfPortableInk",reference))
            repo.close();repo.open()
            val resource=repo.command("attachmentResource",JSONObject().put("reference",repo.get("notes",saved.id).value.getJSONObject("pdfPortableInk")))
            assertEquals(original,PortableInk.decode(JSONObject(File(resource.getString("path")).readText())))
            instrumentation.runOnMainSync {layer.undo();assertEquals(0,layer.snapshot()!!.strokes.size);layer.redo();assertEquals(original,layer.snapshot())}
        }finally {repo.close()}
    }
    @Test fun installedRealModelStreamsAndCancelsWithoutServer():Unit=runBlocking {
        val instrumentation=InstrumentationRegistry.getInstrumentation();val context=instrumentation.targetContext
        check(context.packageName.endsWith(".acceptance"))
        val selectedPath=InstrumentationRegistry.getArguments().getString("modelPath")
        org.junit.Assume.assumeTrue("A verified modelPath enables actual offline inference",selectedPath!=null)
        val path=selectedPath!!
        if(InstrumentationRegistry.getArguments().getString("requireOffline")=="true") {
            assertFalse("External TCP connectivity must be blocked for this test",canConnect())
        }
        val local=LocalAi(context)
        local.install(Uri.fromFile(File(path)))
        var streamed=""
        withTimeout(180_000){streamed=local.answer("请用一句中文回答：地球的卫星是什么？").first {it.length>=10}}
        assertTrue("No actual local inference output",streamed.isNotBlank())
        // first cancels collection; a second generation must acquire the gate and native resources.
        withTimeout(180_000){assertTrue(local.answer("Reply with hello.").first {it.length>=5}.isNotBlank())}
        val completed=withTimeout(180_000){local.answer("请只回复一个词：月球").last()}
        assertTrue("The installed model did not follow the basic Chinese instruction: $completed",completed.contains("月球"))
        File(context.filesDir,"local-ai-acceptance.txt").writeText("取消前输出：$streamed\n完整回复：$completed")
        local.remove();assertNull(local.model)
    }
    private fun canConnect():Boolean=runCatching {java.net.Socket().use {it.connect(java.net.InetSocketAddress("1.1.1.1",443),3000);true}}.getOrDefault(false)
    @Test fun networkPrecondition() {
        val selected=InstrumentationRegistry.getArguments().getString("networkExpectation")
        org.junit.Assume.assumeTrue("Enable the explicit network precondition test",selected!=null)
        val expected=selected!!
        assertEquals("Test network condition did not take effect",expected=="online",canConnect())
    }
    private inline fun MotionEvent.useEvent(block:(MotionEvent)->Unit){try {block(this)}finally {recycle()}}
}
