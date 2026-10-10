package org.shufang.android

/** Window space, rather than a device model or diagonal, controls layout. */
data class AdaptiveLayout(val width:Float,val height:Float,val rail:Boolean,val contentWidth:Float,val panelWidth:Float,val coverColumns:Int,val sideBySide:Boolean) {
    fun readingWidth(percent:Float)=width*percent.coerceIn(50f,100f)/100f
    companion object {
        fun calculate(width:Float,height:Float,fontScale:Float):AdaptiveLayout {
            require(width.isFinite()&&height.isFinite()&&fontScale.isFinite()&&width>0&&height>0&&fontScale>0)
            val rail=width>=600
            val usable=(width-if(rail)80 else 0).coerceAtLeast(1f)
            val minimum=150f*fontScale.coerceIn(1f,1.5f)
            return AdaptiveLayout(width,height,rail,usable,(width-32).coerceAtMost(420f).coerceAtLeast(1f),((usable-40+18)/(minimum+18)).toInt().coerceAtLeast(1),usable>=840&&height>=480&&fontScale<=1.5f)
        }
    }
}
