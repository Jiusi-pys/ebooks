package org.shufang.android

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.view.MotionEvent
import android.view.View
import android.widget.FrameLayout
import kotlinx.coroutines.CoroutineScope
import org.json.JSONObject
import java.util.UUID
import kotlin.math.hypot

/** Native stylus layer; finger gestures continue to the document below. */
class ReaderHost(context:Context,scope:CoroutineScope,events:(JSONObject)->Unit):FrameLayout(context) {
    val ink=InkLayer(context){value,page->events(JSONObject().put("type","inkChanged").put("page",page).put("ink",value.json()))}
    val document=DocumentWebView(context,scope){event->if(event.optString("type")=="pdfViewport")ink.viewport(event);events(event)}
    init {addView(document,LayoutParams(-1,-1));addView(ink,LayoutParams(-1,-1));ink.isClickable=false}
}
class InkLayer(context:Context,private val changed:(PortableInk,Int)->Unit):View(context) {
    private val previews=linkedMapOf<Int,android.graphics.Bitmap>()
    private var viewport=JSONObject();private var histories=mutableMapOf<Int,InkHistory>();private var draft=mutableListOf<InkPoint>();private var start=0L
    private var erasing=false
    var page=0;private set
    var tool="browse"
    var fingerDrawing=false
    var editable=false
    private val paint=Paint(Paint.ANTI_ALIAS_FLAG).apply {strokeCap=Paint.Cap.ROUND;strokeJoin=Paint.Join.ROUND;style=Paint.Style.STROKE}
    fun viewport(value:JSONObject){val next=value.optInt("page");if(next!=page)finishStroke();viewport=value;page=next;editable=histories.containsKey(page);invalidate()}
    fun load(value:PortableInk?){if(page<=0)return;previews.remove(page)?.recycle();val height=viewport.optDouble("canonicalHeight",1400.0);histories[page]=InkHistory(value?:PortableInk(1000.0,height,emptyList()));editable=true;invalidate()}
    fun preview(page:Int,image:android.graphics.Bitmap){previews.remove(page)?.recycle();previews[page]=image;while(previews.size>5){val key=previews.keys.first();previews.remove(key)?.recycle()};if(this.page==page)editable=false;invalidate()}
    fun snapshot()=histories[page]?.value
    fun undo(){histories[page]?.undo();publish()}
    fun redo(){histories[page]?.redo();publish()}
    private fun finishStroke(){if(!erasing&&draft.isNotEmpty()){histories[page]?.append(InkStroke(UUID.randomUUID().toString(),"pen",listOf(0.0,0.0,0.0,1.0),3.0,draft.toList()));draft.clear();publish()}}
    override fun onWindowVisibilityChanged(visibility:Int){if(visibility!=VISIBLE)finishStroke();super.onWindowVisibilityChanged(visibility)}
    override fun onDetachedFromWindow(){finishStroke();previews.values.forEach {it.recycle()};previews.clear();super.onDetachedFromWindow()}
    private fun publish(){snapshot()?.let {changed(it,page)};invalidate()}
    private fun screen(p:InkPoint):Pair<Float,Float> {
        val h=viewport.optDouble("canonicalHeight",1400.0);val r=viewport.optInt("rotation");val rotated=when(r){90->Pair(h-p.y,p.x);180->Pair(1000-p.x,h-p.y);270->Pair(p.y,1000-p.x);else->Pair(p.x,p.y)}
        val scale=width/viewport.optDouble("windowWidth",width.toDouble());val w=if(r==90||r==270)h else 1000.0;val rh=if(r==90||r==270)1000.0 else h
        return Pair(((viewport.optDouble("left")+rotated.first/w*viewport.optDouble("width"))*scale).toFloat(),((viewport.optDouble("top")+rotated.second/rh*viewport.optDouble("height"))*scale).toFloat())
    }
    private fun point(event:MotionEvent,index:Int=-1):InkPoint {
        val scale=width/viewport.optDouble("windowWidth",width.toDouble());val h=viewport.optDouble("canonicalHeight",1400.0);val r=viewport.optInt("rotation")
        val ex=if(index<0)event.x else event.getHistoricalX(index);val ey=if(index<0)event.y else event.getHistoricalY(index)
        val rx=((ex/scale-viewport.optDouble("left"))/viewport.optDouble("width"))*(if(r==90||r==270)h else 1000.0)
        val ry=((ey/scale-viewport.optDouble("top"))/viewport.optDouble("height"))*(if(r==90||r==270)1000.0 else h)
        val pair=when(r){90->Pair(ry,h-rx);180->Pair(1000-rx,h-ry);270->Pair(1000-ry,rx);else->Pair(rx,ry)}
        val time=if(index<0)event.eventTime else event.getHistoricalEventTime(index)
        val pressure=if(index<0)event.pressure else event.getHistoricalPressure(index)
        return InkPoint(pair.first.coerceIn(0.0,1000.0),pair.second.coerceIn(0.0,h),pressure.toDouble().coerceIn(0.0,1.0),event.getAxisValue(MotionEvent.AXIS_TILT).toDouble(),event.getAxisValue(MotionEvent.AXIS_ORIENTATION).toDouble(),(time-start).coerceAtLeast(0)/1000.0)
    }
    override fun onTouchEvent(event:MotionEvent):Boolean {
        if(!editable||tool=="browse"||page<=0)return false
        val stylus=event.getToolType(0) in listOf(MotionEvent.TOOL_TYPE_STYLUS,MotionEvent.TOOL_TYPE_ERASER)
        if(!stylus&&!fingerDrawing)return false
        val history=histories[page]?:return false
        when(event.actionMasked){
            MotionEvent.ACTION_DOWN->{
                val scale=width/viewport.optDouble("windowWidth",width.toDouble())
                val x=event.x/scale;val y=event.y/scale
                if(x<viewport.optDouble("left")||x>viewport.optDouble("left")+viewport.optDouble("width")||y<viewport.optDouble("top")||y>viewport.optDouble("top")+viewport.optDouble("height"))return false
                parent?.requestDisallowInterceptTouchEvent(true);start=event.eventTime;draft.clear();draft.add(point(event));erasing=tool=="erase"||event.getToolType(0)==MotionEvent.TOOL_TYPE_ERASER;if(erasing){draft.clear();val touched=history.value.strokes.lastOrNull {s->s.points.any {p->val screen=screen(p);hypot(screen.first-event.x,screen.second-event.y)<24*resources.displayMetrics.density}};touched?.let {history.erase(it.id);publish()};return true}}
            MotionEvent.ACTION_MOVE->{if(!erasing){for(i in 0 until event.historySize)draft.add(point(event,i));draft.add(point(event));invalidate()}}
            MotionEvent.ACTION_UP->{if(!erasing&&draft.isNotEmpty()){draft.add(point(event));finishStroke()};parent?.requestDisallowInterceptTouchEvent(false)}
            MotionEvent.ACTION_CANCEL->{finishStroke();invalidate();parent?.requestDisallowInterceptTouchEvent(false)}
        }
        return true
    }
    override fun onDraw(canvas:Canvas){super.onDraw(canvas);
        previews[page]?.let {bitmap->val h=viewport.optDouble("canonicalHeight",1400.0);val corners=listOf(screen(InkPoint(0.0,0.0,1.0,0.0,0.0,0.0)),screen(InkPoint(1000.0,0.0,1.0,0.0,0.0,0.0)),screen(InkPoint(1000.0,h,1.0,0.0,0.0,0.0)),screen(InkPoint(0.0,h,1.0,0.0,0.0,0.0)));val transform=android.graphics.Matrix();transform.setPolyToPoly(floatArrayOf(0f,0f,bitmap.width.toFloat(),0f,bitmap.width.toFloat(),bitmap.height.toFloat(),0f,bitmap.height.toFloat()),0,corners.flatMap {listOf(it.first,it.second)}.toFloatArray(),0,4);canvas.drawBitmap(bitmap,transform,null)}
        val strokes=snapshot()?.strokes.orEmpty()+if(draft.isNotEmpty())listOf(InkStroke("draft","pen",listOf(0.0,0.0,0.0,1.0),3.0,draft))else emptyList();for(s in strokes){paint.color=android.graphics.Color.argb((s.color[3]*255).toInt(),(s.color[0]*255).toInt(),(s.color[1]*255).toInt(),(s.color[2]*255).toInt());if(s.points.size==1){val point=screen(s.points[0]);paint.style=Paint.Style.FILL;canvas.drawCircle(point.first,point.second,(s.width*viewport.optDouble("width")/2000*width/viewport.optDouble("windowWidth",width.toDouble())).toFloat().coerceAtLeast(.5f),paint);paint.style=Paint.Style.STROKE};for(i in 1 until s.points.size){val a=screen(s.points[i-1]);val b=screen(s.points[i]);paint.strokeWidth=(s.width*(.3+.7*s.points[i].pressure)*viewport.optDouble("width")/1000*width/viewport.optDouble("windowWidth",width.toDouble())).toFloat().coerceAtLeast(.5f);canvas.drawLine(a.first,a.second,b.first,b.second,paint)}}}
}
