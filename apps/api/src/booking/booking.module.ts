import { Module } from '@nestjs/common'
import { AvailabilityService } from './availability.service'
import { BookingRepository } from './booking.repository'
import { BookingService } from './booking.service'
import {
  PublicAvailabilityController,
  PanelAvailabilityController,
} from './availability.controller'
import {
  PublicBookingController,
  PublicAppointmentController,
  CatalogController,
  PanelAppointmentController,
  CustomerController,
} from './booking.controller'
import { NotificationsModule } from '../notifications/notifications.module'

@Module({
  imports: [NotificationsModule],
  controllers: [
    PublicAvailabilityController,
    PanelAvailabilityController,
    PublicBookingController,
    PublicAppointmentController,
    CatalogController,
    PanelAppointmentController,
    CustomerController,
  ],
  providers: [AvailabilityService, BookingRepository, BookingService],
  exports: [BookingRepository, AvailabilityService, BookingService],
})
export class BookingModule {}
