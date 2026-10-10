package org.shufang.android
import org.json.JSONObject
import org.json.JSONArray

data class AccountRouteGroup(val anchor:String,val userID:String,val workspaceID:String,val addresses:List<String>,val manual:String?) {
    fun accepts(user:String,workspace:String)=userID==user&&workspaceID==workspace&&workspace.isNotBlank()
    fun json():JSONObject {require(addresses.size in 1..8&&addresses.toSet().size==addresses.size&&addresses.all {RemoteAddress.normalize(it)==it}&&anchor in addresses&&manual?.let {it in addresses}!=false);return JSONObject().put("version",2).put("anchor",anchor).put("userID",userID).put("workspaceID",workspaceID).put("addresses",JSONArray(addresses)).put("manual",manual?:JSONObject.NULL)}
    companion object {fun decode(value:JSONObject):AccountRouteGroup {require(value.getInt("version")==2);val list=value.getJSONArray("addresses");return AccountRouteGroup(value.getString("anchor"),value.getString("userID"),value.getString("workspaceID"),(0 until list.length()).map {list.getString(it)},if(value.isNull("manual"))null else value.getString("manual")).also {it.json()}}}
}
data class RouteMeasurement(val address:String,val milliseconds:Double?,val error:String?=null)
object RouteSelection {
    fun best(values:List<RouteMeasurement>,current:String?,manual:String?):String? {
        val available=values.filter {it.milliseconds?.let {value->value.isFinite()&&value>=0}==true}
        if(manual!=null)return available.find {it.address==manual}?.address
        val fastest=available.minByOrNull {it.milliseconds!!}?:return null
        val old=available.find {it.address==current}
        if(old!=null&&old.milliseconds!!-fastest.milliseconds!!<maxOf(30.0,old.milliseconds*.2))return old.address
        return fastest.address
    }
}
