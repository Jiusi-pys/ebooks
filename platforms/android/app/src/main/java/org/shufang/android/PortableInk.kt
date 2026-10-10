package org.shufang.android

import org.json.JSONObject
import org.json.JSONArray

data class InkPoint(val x:Double,val y:Double,val pressure:Double,val tilt:Double,val azimuth:Double,val time:Double)
data class InkStroke(val id:String,val tool:String,val color:List<Double>,val width:Double,val points:List<InkPoint>)
data class PortableInk(val width:Double,val height:Double,val strokes:List<InkStroke>) {
    fun validate() {
        require(width==1000.0&&height.isFinite()&&height>0&&height<=100_000){"invalid_ink_canvas"}
        require(strokes.size<=10_000&&strokes.map {it.id}.toSet().size==strokes.size){"invalid_ink_strokes"}
        var total=0
        strokes.forEach {s->require(s.id.isNotBlank()&&s.id.length<=128&&s.tool in listOf("pen","pencil","marker")&&s.color.size==4&&s.color.all {it.isFinite()&&it in 0.0..1.0}&&s.width.isFinite()&&s.width>0&&s.width<=100){"invalid_ink_stroke"}
            total+=s.points.size;require(s.points.isNotEmpty()&&total<=1_000_000){"ink_too_large"}
            var last=-1.0;s.points.forEach {p->require(listOf(p.x,p.y,p.pressure,p.tilt,p.azimuth,p.time).all {it.isFinite()}&&p.x in 0.0..width&&p.y in 0.0..height&&p.pressure in 0.0..1.0&&p.time>=0&&p.time>=last){"invalid_ink_point"};last=p.time}
        }
    }
    fun json():JSONObject {validate();return JSONObject().put("format","ShufangPortableInk").put("version",1).put("width",width).put("height",height).put("strokes",JSONArray(strokes.map {s->JSONObject().put("id",s.id).put("tool",s.tool).put("color",JSONArray(s.color)).put("width",s.width).put("points",JSONArray(s.points.map {p->JSONObject().put("x",p.x).put("y",p.y).put("pressure",p.pressure).put("tilt",p.tilt).put("azimuth",p.azimuth).put("time",p.time)}))}))}
    companion object {
        fun decode(value:JSONObject):PortableInk {
            require(value.optString("format")=="ShufangPortableInk"&&value.optDouble("version")==1.0){"unsupported_ink_version"}
            val array=value.getJSONArray("strokes");require(array.length()<=10_000){"ink_too_large"}
            var total=0L
            for(index in 0 until array.length()){val stroke=array.getJSONObject(index);total+=stroke.getJSONArray("points").length();require(total<=1_000_000&&stroke.getJSONArray("color").length()==4){"ink_too_large"}}
            val result=PortableInk(value.getDouble("width"),value.getDouble("height"),(0 until array.length()).map {index->val s=array.getJSONObject(index);val points=s.getJSONArray("points");require(points.length()<=1_000_000){"ink_too_large"};InkStroke(s.getString("id"),s.getString("tool"),(0 until s.getJSONArray("color").length()).map {s.getJSONArray("color").getDouble(it)},s.getDouble("width"),(0 until points.length()).map {i->val p=points.getJSONObject(i);InkPoint(p.getDouble("x"),p.getDouble("y"),p.getDouble("pressure"),p.getDouble("tilt"),p.optDouble("azimuth",0.0),p.getDouble("time"))})})
            result.validate();return result
        }
    }
}
class InkHistory(initial:PortableInk) {
    var value=initial;private set
    private val undo=ArrayDeque<PortableInk>();private val redo=ArrayDeque<PortableInk>()
    private fun replace(next:PortableInk){next.validate();undo.addLast(value);while(undo.size>100)undo.removeFirst();value=next;redo.clear()}
    fun append(stroke:InkStroke)=replace(value.copy(strokes=value.strokes+stroke))
    fun erase(id:String){if(value.strokes.any {it.id==id})replace(value.copy(strokes=value.strokes.filterNot {it.id==id}))}
    fun undo(){if(undo.isNotEmpty()){redo.addLast(value);value=undo.removeLast()}}
    fun redo(){if(redo.isNotEmpty()){undo.addLast(value);value=redo.removeLast()}}
}
